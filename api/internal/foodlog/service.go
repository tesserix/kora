package foodlog

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

// resolveEnteredUnit resolves an entered (amount, unit) pair into grams
// against item, exactly once, at write time. The SERVER derives
// quantity_grams here — the client never converts — and the result is what
// every nutrition figure on the row is computed from thereafter. A later
// correction to a serving mass therefore changes future logs only, and never
// rewrites what a past day's totals said. units.ErrNoConversion (and any
// other resolution error) surfaces as a validation error; it is never
// swallowed into a default.
//
// The actual resolution (decode ServingUnits + ToBase) lives in
// units.ResolveEntered, shared with savedmeals, so both surfaces resolve
// identically — this wrapper only extracts the fields units.ResolveEntered
// needs from a nutrition.FoodItem and translates its error into an
// httpx.ValidationError using units.UnrecognisedUnitMessage, since the units
// package itself stays free of both the nutrition and httpx dependencies.
func resolveEnteredUnit(amount float64, unit string, item nutrition.FoodItem) (float64, error) {
	grams, err := units.ResolveEntered(amount, unit, item.BaseUnit, item.ServingUnits)
	if err != nil {
		return 0, httpx.ValidationError{Message: units.UnrecognisedUnitMessage}
	}
	return grams, nil
}

// ResolutionCache is the subset of ai.Cache a correction needs: the ability
// to evict one stale cached Resolution by key. It is declared locally
// (rather than depending on ai.Cache directly) so foodlog does not take a
// hard dependency on the concrete cache implementation backing resolution
// (e.g. Redis) — any type with this one method, including *ai.RedisCache and
// ai.NoCache, satisfies it structurally.
type ResolutionCache interface {
	Delete(ctx context.Context, key string) error
}

type LogRequest struct {
	FoodItemID    *uuid.UUID `json:"food_item_id"`
	Description   string     `json:"description"`
	MealSlot      string     `json:"meal_slot"`
	Source        string     `json:"source"`
	QuantityGrams float64    `json:"quantity_grams"`
	// EnteredAmount/EnteredUnit carry what the user actually typed ("2
	// sachet"). When both are set, the server resolves them into
	// QuantityGrams exactly once, here — the client never converts, and the
	// resolved grams (not the entered pair) drive every nutrition figure. Nil
	// means a legacy gram-entered log; QuantityGrams is used as-is.
	EnteredAmount *float64  `json:"entered_amount"`
	EnteredUnit   *string   `json:"entered_unit"`
	LoggedAt      time.Time `json:"logged_at"`
	ClientLogMs   *int      `json:"client_log_ms"`
	InputPhrase   *string   `json:"input_phrase"`
	// ID lets the client mint the log's identity before it has network, so a
	// queued write replayed after a lost response is idempotent. Optional:
	// when nil the column default generates one as before.
	ID *uuid.UUID `json:"id"`
}

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

// ValidMealSlot reports whether slot is a meal slot the diary accepts. It is
// exported so other packages that gate on a meal slot before calling into
// this one (recipes) cannot drift from the diary's own list.
func ValidMealSlot(slot string) bool { return validMealSlots[slot] }

// resolveSources are the log sources that carry a user phrase worth keeping.
// A manual, memory, barcode or photo log has no phrase that resolved wrong,
// so there is nothing a correction could teach the index with.
var resolveSources = map[string]bool{"ai_text": true, "ai_voice": true}

// phraseForSource keeps a non-blank input phrase only for resolve sources,
// and only when it has content after trimming.
func phraseForSource(source string, phrase *string) *string {
	if !resolveSources[source] || phrase == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*phrase)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

type Service struct {
	logs  Repository
	foods nutrition.Repository
	cache ResolutionCache
}

func NewService(logs Repository, foods nutrition.Repository) Service {
	return Service{logs: logs, foods: foods}
}

// WithResolutionCache attaches an optional resolution-cache invalidator,
// following the same functional-option pattern as social.Service.WithNotifier
// and groups.Service.WithNotifier — added instead of a third NewService
// parameter so the ~30 existing call sites across the codebase and tests
// don't all need updating for an optional dependency. A nil cache (the
// default — e.g. in every existing NewService call site, and in
// router.go/main.go when Redis is unreachable or unconfigured) is a silent
// no-op: see invalidateResolutionCache.
func (s Service) WithResolutionCache(cache ResolutionCache) Service {
	s.cache = cache
	return s
}

// invalidateResolutionCache evicts the cached AI Resolution for (userID,
// phrase) after a correction teaches or retracts an alias, so the next
// resolve of that phrase doesn't keep serving a Resolution that was cached
// BEFORE the correction. Nil-safe (no-op when no cache is configured) and
// best-effort, exactly like the alias write/retraction itself — a cache
// problem must never fail the edit.
func (s Service) invalidateResolutionCache(ctx context.Context, userID uuid.UUID, phrase string) {
	if s.cache == nil {
		return
	}
	key := ai.CacheKey("phrase", userID, phrase)
	if err := s.cache.Delete(ctx, key); err != nil {
		slog.WarnContext(ctx, "foodlog: resolution cache invalidation failed",
			"error", err, "user_id", userID)
	}
}

func (s Service) LogFood(ctx context.Context, userID uuid.UUID, req LogRequest) (FoodLog, error) {
	if !validMealSlots[req.MealSlot] {
		return FoodLog{}, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	if req.FoodItemID == nil {
		return FoodLog{}, httpx.ValidationError{Message: "food_item_id is required"}
	}
	item, err := s.foods.GetByID(ctx, *req.FoodItemID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Mirrors EditLog's and CreateBatch's mapping of the same error:
			// GetByID now filters deleted_at, so this is reachable whenever a
			// client's food picker cache predates a retire, or an
			// offline-queued log is replayed after one. Must be a 400, not a
			// 500 — a 400 is permanent and fails on the first refusal with a
			// legible message, whereas a 500 costs five wasted replays across
			// drain triggers before the entry moves to failed.
			return FoodLog{}, httpx.ValidationError{Message: "food_item_id not found"}
		}
		return FoodLog{}, fmt.Errorf("foodlog: resolve food: %w", err)
	}
	// When the caller entered a unit, the SERVER derives quantity_grams from
	// it — the client never converts. Resolution happens exactly once, here,
	// and the result is what every nutrition figure is computed from
	// thereafter.
	if req.EnteredAmount != nil && req.EnteredUnit != nil {
		grams, err := resolveEnteredUnit(*req.EnteredAmount, *req.EnteredUnit, item)
		if err != nil {
			return FoodLog{}, err
		}
		req.QuantityGrams = grams
	}
	if req.QuantityGrams <= 0 {
		return FoodLog{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
	}
	f := req.QuantityGrams / 100.0
	source := req.Source
	if source == "" {
		source = "manual"
	}
	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	log := FoodLog{
		UserID:        userID,
		FoodItemID:    req.FoodItemID,
		LoggedAt:      loggedAt,
		MealSlot:      req.MealSlot,
		Source:        source,
		Description:   item.Name,
		QuantityGrams: req.QuantityGrams,
		EnteredAmount: req.EnteredAmount,
		EnteredUnit:   req.EnteredUnit,
		Kcal:          item.KcalPer100g * f,
		ProteinG:      item.ProteinPer100g * f,
		CarbsG:        item.CarbsPer100g * f,
		FatG:          item.FatPer100g * f,
		FiberG:        item.FiberPer100g * f,
		Provenance:    item.Provenance,
		ClientLogMs:   req.ClientLogMs,
		InputPhrase:   phraseForSource(source, req.InputPhrase),
	}
	// Assigned after construction, not inside the literal: FoodLog.ID is a
	// value type, so writing uuid.Nil into it when the client sent no id
	// would defeat the column's gen_random_uuid() default.
	if req.ID != nil {
		log.ID = *req.ID
	}
	created, err := s.logs.CreateIdempotent(ctx, log)
	if err != nil {
		return FoodLog{}, err
	}
	// The create path does not go through the joined read scope, so carry the
	// food's base unit onto the response by hand — a client that renders the
	// row it just created must label it the same way the diary will. It is a
	// label only; nothing is computed from it.
	created.BaseUnit = item.BaseUnit
	return created, nil
}

// EditRequest carries a partial edit to an existing log. Nil/zero fields mean
// "leave unchanged", except MealSlot which, when non-empty, is validated.
// Nutrition is NEVER taken from the request — it is always recomputed from the
// (possibly new) food row.
//
// The correction phrase is NOT client-supplied: it is read from the log's own
// input_phrase, so a client cannot mint an alias for a phrase the user never
// uttered.
//
// RetractCorrection un-teaches what a previous correction on this log taught —
// it deletes the personal alias (user, log.input_phrase, the food the log
// pointed at BEFORE this edit) once the edit has successfully applied and
// actually changed the food. It is the undo half of a correction, and it
// never writes an alias of its own.
//
// Either half of a correction (teach or retract) also evicts the AI resolve
// cache entry for (user, log.input_phrase) when a ResolutionCache is
// configured (see WithResolutionCache) — otherwise the phrase could keep
// resolving to the pre-correction answer out of cache for up to the cache's
// TTL, even though food_aliases was updated immediately.
type EditRequest struct {
	FoodItemID    *uuid.UUID `json:"food_item_id"`
	MealSlot      string     `json:"meal_slot"`
	QuantityGrams *float64   `json:"quantity_grams"`
	// EnteredAmount/EnteredUnit, when both supplied, re-resolve
	// quantity_grams from the new entered pair (server-side, exactly like
	// LogFood). When only QuantityGrams is supplied, the previously-stored
	// entered pair is nulled — it no longer describes the amount once grams
	// were overwritten directly.
	EnteredAmount     *float64   `json:"entered_amount"`
	EnteredUnit       *string    `json:"entered_unit"`
	LoggedAt          *time.Time `json:"logged_at"`
	RetractCorrection bool       `json:"retract_correction"`
}

// EditResult is an edited log plus whether the edit taught the food index.
// AliasRecorded is reported rather than inferred so the client's confirmation
// copy ("Kora will remember …") can never claim a best-effort write that
// actually failed.
type EditResult struct {
	Log           FoodLog
	AliasRecorded bool
}

func (s Service) EditLog(ctx context.Context, userID, logID uuid.UUID, req EditRequest) (EditResult, error) {
	current, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return EditResult{}, fmt.Errorf("foodlog: edit: load: %w", err)
	}

	// Capture the food the log pointed at BEFORE this edit, while it's still
	// current.FoodItemID. We key retraction on this captured value rather than
	// on ordering: current.FoodItemID is about to be overwritten below, and
	// retraction itself must not run until AFTER a successful Update (see
	// below) so a rejected edit (bad meal_slot, non-positive grams, unknown
	// food) never destroys an alias for a change that didn't happen.
	prevFoodID := current.FoodItemID

	if req.MealSlot != "" {
		if !validMealSlots[req.MealSlot] {
			return EditResult{}, httpx.ValidationError{Message: "invalid meal_slot"}
		}
		current.MealSlot = req.MealSlot
	}
	if req.LoggedAt != nil {
		current.LoggedAt = *req.LoggedAt
	}

	foodChanged := req.FoodItemID != nil && (current.FoodItemID == nil || *req.FoodItemID != *current.FoodItemID)

	if req.FoodItemID != nil {
		current.FoodItemID = req.FoodItemID
	}

	// When the caller supplies a new entered pair, re-resolve quantity_grams
	// from it server-side, exactly like LogFood — the client never converts,
	// and this is the ONLY point at which the new grams figure is derived.
	// When only QuantityGrams is supplied directly, the previously-stored
	// entered pair is nulled: it no longer describes the amount once grams
	// were overwritten without going through a unit.
	gramsChanged := false
	switch {
	case req.EnteredAmount != nil && req.EnteredUnit != nil:
		if current.FoodItemID == nil {
			return EditResult{}, httpx.ValidationError{Message: "food_item_id required to resolve unit"}
		}
		item, err := s.foods.GetByID(ctx, *current.FoodItemID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return EditResult{}, httpx.ValidationError{Message: "food_item_id not found"}
			}
			return EditResult{}, fmt.Errorf("foodlog: edit: resolve food: %w", err)
		}
		grams, err := resolveEnteredUnit(*req.EnteredAmount, *req.EnteredUnit, item)
		if err != nil {
			return EditResult{}, err
		}
		gramsChanged = grams != current.QuantityGrams
		current.QuantityGrams = grams
		current.EnteredAmount = req.EnteredAmount
		current.EnteredUnit = req.EnteredUnit
	case req.QuantityGrams != nil:
		if *req.QuantityGrams <= 0 {
			return EditResult{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
		}
		gramsChanged = *req.QuantityGrams != current.QuantityGrams
		current.QuantityGrams = *req.QuantityGrams
		current.EnteredAmount = nil
		current.EnteredUnit = nil
	}

	// Recompute nutrition from the row whenever food or grams changed.
	if foodChanged || gramsChanged {
		if current.FoodItemID == nil {
			return EditResult{}, httpx.ValidationError{Message: "food_item_id required to recompute nutrition"}
		}
		item, err := s.foods.GetByID(ctx, *current.FoodItemID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// The LOG exists (loaded above); it's the FOOD that's missing —
				// a client-supplied bad food_item_id, not a "log not found" case.
				return EditResult{}, httpx.ValidationError{Message: "food_item_id not found"}
			}
			return EditResult{}, fmt.Errorf("foodlog: edit: resolve food: %w", err)
		}
		f := current.QuantityGrams / 100.0
		current.Description = item.Name
		current.Kcal = item.KcalPer100g * f
		current.ProteinG = item.ProteinPer100g * f
		current.CarbsG = item.CarbsPer100g * f
		current.FatG = item.FatPer100g * f
		current.FiberG = item.FiberPer100g * f
		current.Provenance = item.Provenance
	}

	updated, err := s.logs.Update(ctx, current)
	if err != nil {
		return EditResult{}, err
	}

	// Teach the index: map the phrase that resolved wrong to the corrected
	// item, personal to this user, so their future resolves hit the alias
	// tier. An undo never teaches. Best-effort — an alias write must not fail
	// the edit.
	aliasRecorded := false
	if foodChanged && !req.RetractCorrection && current.InputPhrase != nil && current.FoodItemID != nil {
		if aerr := s.foods.AddAlias(ctx, userID, *current.InputPhrase, *current.FoodItemID); aerr != nil {
			slog.WarnContext(ctx, "foodlog: correction alias write failed",
				"error", aerr, "food_item_id", *current.FoodItemID, "user_id", userID)
		} else {
			aliasRecorded = true
			// The old resolution for this phrase may still be sitting in the AI
			// resolve cache (up to 24h TTL) — evict it so the user's next
			// resolve of the same phrase hits the alias just taught, instead of
			// serving back the same wrong answer they just corrected.
			s.invalidateResolutionCache(ctx, userID, *current.InputPhrase)
		}
	}

	// Retract: un-teach the alias the earlier correction created, keyed on
	// prevFoodID (the food this log pointed at before this edit ran) — never
	// on current.FoodItemID, which now names the food being reverted TO and
	// was never taught by any correction. Gated on foodChanged AND a
	// successful Update above, so a bare {retract_correction: true} with no
	// food change, or an edit that failed validation, never destroys an
	// alias. Best-effort, same as the teach half.
	if req.RetractCorrection && foodChanged && current.InputPhrase != nil && prevFoodID != nil {
		if rerr := s.foods.RemoveAlias(ctx, userID, *current.InputPhrase, *prevFoodID); rerr != nil {
			slog.WarnContext(ctx, "foodlog: correction alias retraction failed",
				"error", rerr, "food_item_id", *prevFoodID, "user_id", userID)
		} else {
			// The correction's Resolution may still be cached under this
			// phrase — evict it so a future resolve stops reflecting the
			// now-retracted alias.
			s.invalidateResolutionCache(ctx, userID, *current.InputPhrase)
		}
	}

	return EditResult{Log: updated, AliasRecorded: aliasRecorded}, nil
}

// BatchItem is one food entry within a CreateBatchRequest. Only the food
// reference and quantity are client-supplied — all nutrition is recomputed
// server-side from the resolved FoodItem row.
//
// EnteredAmount/EnteredUnit carry what a saved meal's item was actually
// saved in ("2 sachet"). When both are set, the server resolves them into
// QuantityGrams exactly once, here — the client never converts, and the
// resolved grams (not the entered pair) drive every nutrition figure. A
// client sends QuantityGrams: 0 as a placeholder when an entered pair is
// present. Nil means a legacy gram-entered item; QuantityGrams is used as-is.
type BatchItem struct {
	FoodItemID    uuid.UUID `json:"food_item_id"`
	QuantityGrams float64   `json:"quantity_grams"`
	EnteredAmount *float64  `json:"entered_amount"`
	EnteredUnit   *string   `json:"entered_unit"`
}

// CreateBatchRequest logs several foods as a single meal (e.g. all items on a
// plate) in one atomic call.
type CreateBatchRequest struct {
	LoggedAt time.Time   `json:"logged_at"`
	MealSlot string      `json:"meal_slot"`
	Items    []BatchItem `json:"items"`
	// Source tags every log this batch creates. Empty means "memory", which
	// is what every caller before recipes meant and keeps existing behaviour
	// byte-identical. Recipes pass "recipe" so recipe-driven logs are
	// distinguishable from hand-entered ones in analytics.
	//
	// Constrained to batchSources below. This field is bound straight from the
	// request body, so an unconstrained value let a client write rows into the
	// correction-eligible source set with no input_phrase — violating the
	// invariant 000020_log_corrections documents — or make batch rows
	// indistinguishable from hand-entered ones in dashboard.SourceCounts.
	Source string `json:"source"`
}

// batchSources are the sources a BATCH may claim. A batch is always a
// server-shaped fan-out of several foods at once (memory re-log, saved meal,
// recipe); none of them carries a user phrase, so no ai_* source can honestly
// originate here, and "manual" would misreport a fan-out as hand entry.
var batchSources = map[string]bool{"memory": true, "meal": true, "recipe": true}

// CreateBatch logs several foods as one meal in a single transaction. Macros
// are recomputed server-side per item (item per-100g × grams) — identical to
// the math in LogFood — so no client-supplied nutrition is ever trusted.
// All-or-nothing: if any item's food_item_id doesn't resolve, or has a
// non-positive quantity, the entire batch is rolled back and no logs are
// created.
func (s Service) CreateBatch(ctx context.Context, userID uuid.UUID, req CreateBatchRequest) ([]FoodLog, error) {
	if len(req.Items) == 0 {
		return nil, httpx.ValidationError{Message: "items must not be empty"}
	}
	if !validMealSlots[req.MealSlot] {
		return nil, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	source := req.Source
	if source == "" {
		source = "memory"
	}
	if !batchSources[source] {
		return nil, httpx.ValidationError{Message: "invalid source"}
	}

	out := make([]FoodLog, 0, len(req.Items))
	err := s.logs.Transaction(ctx, func(txLogs Repository) error {
		for _, it := range req.Items {
			// The food row is loaded BEFORE the quantity guard (unlike the
			// original ordering) because unit resolution below needs it —
			// exactly how LogFood orders these two steps.
			item, err := s.foods.GetByID(ctx, it.FoodItemID)
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					// Client supplied a food_item_id that doesn't resolve — a
					// 400. This item most commonly arrived from a saved meal
					// (savedmeals.Repository.ItemsForMeals deliberately keeps
					// an unfiltered JOIN, so a meal can still display a
					// retired item) — the user never typed this id and can't
					// recognize it, so name the FOOD that's unavailable when
					// we can. NameForID bypasses the soft-delete filter
					// purely to look up the name for this message; it does
					// not change the all-or-nothing failure of the batch.
					if name, ok := s.foods.NameForID(ctx, it.FoodItemID); ok {
						return httpx.ValidationError{Message: fmt.Sprintf("food no longer available: %s", name)}
					}
					return httpx.ValidationError{Message: "unknown food_item_id"}
				}
				// Infra/DB fault resolving the food — must not be a client 400.
				return fmt.Errorf("foodlog: batch: resolve food: %w", err)
			}

			// A saved meal logs each item in the unit it was saved in. The
			// SERVER resolves it, once, here — the client sends
			// quantity_grams: 0 as a placeholder when an entered pair is
			// present, so the positive-quantity guard below must run against
			// the RESOLVED figure, not the client's placeholder zero.
			grams := it.QuantityGrams
			if it.EnteredAmount != nil && it.EnteredUnit != nil {
				resolved, rerr := resolveEnteredUnit(*it.EnteredAmount, *it.EnteredUnit, item)
				if rerr != nil {
					// Name the ingredient. The user picked a meal, not an id —
					// the unresolvable-food path above already reasons this
					// way.
					if name, ok := s.foods.NameForID(ctx, it.FoodItemID); ok {
						return httpx.ValidationError{Message: fmt.Sprintf("%s: %s", name, units.UnrecognisedUnitMessage)}
					}
					return httpx.ValidationError{Message: units.UnrecognisedUnitMessage}
				}
				grams = resolved
			}
			if grams <= 0 {
				return httpx.ValidationError{Message: "quantity_grams must be positive"}
			}

			fid := it.FoodItemID
			f := grams / 100.0
			created, err := txLogs.Create(ctx, FoodLog{
				UserID:        userID,
				FoodItemID:    &fid,
				LoggedAt:      loggedAt,
				MealSlot:      req.MealSlot,
				Source:        source,
				Description:   item.Name,
				QuantityGrams: grams,
				EnteredAmount: it.EnteredAmount,
				EnteredUnit:   it.EnteredUnit,
				Kcal:          item.KcalPer100g * f,
				ProteinG:      item.ProteinPer100g * f,
				CarbsG:        item.CarbsPer100g * f,
				FatG:          item.FatPer100g * f,
				FiberG:        item.FiberPer100g * f,
				Provenance:    item.Provenance,
			})
			if err != nil {
				return err
			}
			out = append(out, created)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s Service) CopyDay(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (int, error) {
	src, err := s.logs.ListByUserAndDay(ctx, userID, from, loc)
	if err != nil {
		return 0, err
	}
	dayDelta := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc).
		Sub(time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc))
	count := 0
	for _, l := range src {
		clone := l
		clone.ID = uuid.Nil
		clone.CreatedAt = time.Time{}
		clone.LoggedAt = l.LoggedAt.Add(dayDelta)
		if _, err := s.logs.Create(ctx, clone); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func (s Service) RepeatLog(ctx context.Context, userID, logID uuid.UUID, at time.Time) (FoodLog, error) {
	src, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return FoodLog{}, err
	}
	clone := src
	clone.ID = uuid.Nil
	clone.CreatedAt = time.Time{}
	clone.LoggedAt = at
	return s.logs.Create(ctx, clone)
}
