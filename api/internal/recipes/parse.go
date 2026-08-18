package recipes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

// ErrParseFailed means extraction did not produce a usable recipe. The
// handler turns it into a 502 the client renders as "couldn't read that
// recipe — enter it manually", dropping the user into the manual editor.
// Parse is best-effort by nature; a dead end here must not be a dead end for
// the task.
var ErrParseFailed = errors.New("recipes: could not parse")

// ErrBudgetExhausted means the caller (or the platform) has exhausted an AI
// quota or cost cap. The handler turns it into a 429 rather than a parse
// failure: nothing was wrong with the recipe, so telling the user to retry
// would be a lie.
// Recipes still work — the manual editor needs no provider at all.
var ErrBudgetExhausted = errors.New("recipes: ai budget exhausted")

const (
	// callTypeParseText / callTypeParsePhoto label every provider call this
	// package makes in ai_usage_events and in the Prometheus AI metrics, so
	// recipe parsing is visible in COGS and — the #81 lesson — a never-working
	// parse path is distinguishable from a never-attempted one. They are also
	// registered in metrics.classByCallType so they do not bucket to "other".
	callTypeParseText  = "parse_recipe_text"
	callTypeParsePhoto = "parse_recipe_photo"

	maxPasteLen = 6000
	// defaultAssumedGrams is the portion used when neither the model nor the
	// food row offers one. It is ALWAYS paired with PortionAssumed=true so it
	// can never be rendered as a measurement (#138).
	defaultAssumedGrams = 100.0
	// resolveLimit bounds candidates fetched per ingredient name.
	resolveLimit = 3

	// recipePhotoBudget bounds ONLY ParsePhoto's IdentifyPhoto call. The shared
	// ai.Router photoBudget (20s) is correctly sized for /v1/resolve/photo,
	// which has no second leg after it — but ParsePhoto makes a Decompose call
	// immediately afterward against the SAME client deadline, and 20s leaves no
	// room for it. Wrapping the context passed into IdentifyPhoto with this
	// narrower deadline caps ParsePhoto's effective photo-identify budget
	// without touching router.go's shared photoBudget or /v1/resolve/photo's
	// behavior — context.WithTimeout always yields the earlier of the parent
	// and the new deadline.
	//
	// 13s, not 15s: see recipeDecomposeBudget's comment for why the margin
	// against the mobile client's deadline has to be wider than it looks here.
	recipePhotoBudget = 13 * time.Second

	// recipeDecomposeBudget bounds the ENTIRE Decompose call that follows
	// IdentifyPhoto in ParsePhoto — both the textBudget-bounded primary leg and
	// its fallback (see Router.withFallback in router.go, which derives its
	// child contexts from whatever context it is given). Wrapping the context
	// passed into Decompose here caps the fallback leg's effective budget to
	// whatever is left of this window, WITHOUT changing the shared textBudget
	// or fallbackBudget constants that ai.Resolver.decomposeAndEstimate (the
	// food-resolve hot path) depends on for its own Decompose call — that call
	// site does not wrap its context this way, so it is unaffected.
	//
	// recipePhotoBudget (13s) + recipeDecomposeBudget (7s) = 20s, which fits
	// inside the mobile client's 25s REQUEST_TIMEOUT_MS with 5s of margin for
	// the network and the rest of the request. That margin is deliberately
	// more generous than the 3s generateBudget + generateFallbackBudget
	// (10s + 12s = 22s) uses in router.go, because those two are TEXT calls
	// with a negligible request body, so the client's 25s timer and the
	// server's own budget clock start at essentially the same instant. Here
	// the request body is a multipart photo upload: the client's 25s timer
	// starts when the upload begins, but recipePhotoBudget's clock only
	// starts once that upload has fully arrived server-side and ParsePhoto
	// begins running. The margin against the client deadline has to absorb
	// that upload time too, on top of the network/response overhead the 3s
	// figure already covers — hence 5s here instead of 3s.
	recipeDecomposeBudget = 7 * time.Second
)

// parseSystemPrompt mirrors the discipline in the ai package's own prompts:
// identity and portion only, never a nutrition number.
const parseSystemPrompt = "You extract a structured recipe from text. Return " +
	"JSON ONLY, no prose and no code fences, exactly matching: " +
	`{"name": string, "servings": integer, "ingredients": [{"text": string, "amount": number, "unit": string}]}. ` +
	"\"name\" is the dish name. \"servings\" is how many portions the recipe " +
	"yields — use 1 if the text does not say. Each ingredient's \"text\" is " +
	"the food alone with no quantity in it; \"amount\" and \"unit\" carry the " +
	"quantity (use grams when the text gives grams). Do NOT state any calorie, " +
	"macro, or other nutrition number — nutrition is looked up separately and " +
	"any number you provide would be ignored and could mislead."

// Draft is an UNSAVED parse result. It reuses IngredientInput so the review
// sheet can post it straight back to POST /v1/recipes after the user edits.
type Draft struct {
	Name        string            `json:"name"`
	Servings    int               `json:"servings"`
	Source      string            `json:"source"`
	Ingredients []IngredientInput `json:"ingredients"`
}

type Parser struct {
	provider ai.Provider
	foods    nutrition.Repository
	meter    ai.Meter
}

// NewParser builds a Parser over its collaborators. The meter is REQUIRED, not
// optional: every provider call in this package is billed upstream, and an
// unmetered endpoint both escapes the per-user cap and corrupts the global one
// that protects resolve and coach. billing.Meter satisfies ai.Meter
// structurally — see the interface's own comment.
func NewParser(p ai.Provider, foods nutrition.Repository, meter ai.Meter) *Parser {
	return &Parser{provider: p, foods: foods, meter: meter}
}

// withinBudget gates a parse before the first provider call, exactly as
// ai.Resolver.resolve and coach.Service.Ask do.
func (p *Parser) withinBudget(ctx context.Context, userID uuid.UUID) error {
	ok, err := p.meter.WithinBudget(ctx, userID)
	if err != nil {
		return fmt.Errorf("recipes: parse: check budget: %w", err)
	}
	if !ok {
		return ErrBudgetExhausted
	}
	return nil
}

// record meters one provider call. Metering failures must never break a parse
// — a user's recipe cannot depend on the billing table being reachable — so
// the error is deliberately ignored, matching ai.Resolver.record and
// coach.Service.record.
//
// callType is forced rather than trusted: the providers label GenerateText as
// "coach" and IdentifyPhoto/Decompose as their own types, which would make
// recipe spend indistinguishable from coach's and resolve's.
func (p *Parser) record(ctx context.Context, userID uuid.UUID, u ai.Usage, callType string, err error) {
	if u.Provider == "" {
		u.Provider = p.provider.Name()
	}
	u.CallType = callType
	switch {
	case err == nil && u.Outcome == "":
		u.Outcome = ai.OutcomeOK
	case err != nil && errors.Is(err, context.DeadlineExceeded):
		// A provider timeout is a parse failure, not a 500, and is metered as
		// a timeout so a budget that is too tight stays visible (spec).
		u.Outcome = ai.OutcomeTimeout
	case err != nil:
		u.Outcome = ai.OutcomeError
	}
	_ = p.meter.Record(ctx, userID, u, ai.EstimateCostUSD(u))
}

// extracted is the model's JSON shape. Any field the model invents beyond
// this — kcal included — is dropped by encoding/json.
type extracted struct {
	Name        string `json:"name"`
	Servings    int    `json:"servings"`
	Ingredients []struct {
		Text   string  `json:"text"`
		Amount float64 `json:"amount"`
		Unit   string  `json:"unit"`
	} `json:"ingredients"`
}

func (p *Parser) ParseText(ctx context.Context, userID uuid.UUID, text string) (Draft, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Draft{}, httpx.ValidationError{Message: "paste some recipe text first"}
	}
	if len(text) > maxPasteLen {
		return Draft{}, httpx.ValidationError{Message: "that recipe is too long to read"}
	}

	if err := p.withinBudget(ctx, userID); err != nil {
		return Draft{}, err
	}

	raw, usage, err := p.provider.GenerateText(ctx, parseSystemPrompt, text)
	p.record(ctx, userID, usage, callTypeParseText, err)
	if err != nil {
		return Draft{}, fmt.Errorf("%w: provider: %v", ErrParseFailed, err)
	}

	var ex extracted
	if err := json.Unmarshal([]byte(stripCodeFence(raw)), &ex); err != nil {
		return Draft{}, fmt.Errorf("%w: not json", ErrParseFailed)
	}
	if len(ex.Ingredients) == 0 {
		return Draft{}, fmt.Errorf("%w: no ingredients", ErrParseFailed)
	}

	d := Draft{Name: strings.TrimSpace(ex.Name), Servings: ex.Servings, Source: SourcePaste}
	if d.Name == "" {
		d.Name = "Untitled recipe"
	}
	if d.Servings < 1 {
		d.Servings = 1
	}
	for _, in := range ex.Ingredients {
		name := strings.TrimSpace(in.Text)
		if name == "" {
			continue
		}
		portion := strings.TrimSpace(fmt.Sprintf("%g %s", in.Amount, in.Unit))
		if in.Amount <= 0 {
			portion = ""
		}
		d.Ingredients = append(d.Ingredients, p.resolveIngredient(ctx, userID, name, portion))
	}
	if len(d.Ingredients) == 0 {
		return Draft{}, fmt.Errorf("%w: no usable ingredients", ErrParseFailed)
	}
	return d, nil
}

func (p *Parser) ParsePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (Draft, error) {
	if err := p.withinBudget(ctx, userID); err != nil {
		return Draft{}, err
	}

	photoCtx, photoCancel := context.WithTimeout(ctx, recipePhotoBudget)
	defer photoCancel()
	guesses, usage, err := p.provider.IdentifyPhoto(photoCtx, image, mime)
	p.record(ctx, userID, usage, callTypeParsePhoto, err)
	if err != nil {
		return Draft{}, fmt.Errorf("%w: provider: %v", ErrParseFailed, err)
	}
	if len(guesses) == 0 {
		return Draft{}, fmt.Errorf("%w: nothing identified", ErrParseFailed)
	}

	// Strongest guess names the dish. A photo cannot reveal a yield, so
	// servings defaults to 1 and the user sets it in the review sheet —
	// honest, rather than an invented number.
	best := guesses[0]
	for _, g := range guesses[1:] {
		if g.Confidence > best.Confidence {
			best = g
		}
	}

	decomposeCtx, decomposeCancel := context.WithTimeout(ctx, recipeDecomposeBudget)
	defer decomposeCancel()
	ings, decomposeUsage, err := p.provider.Decompose(decomposeCtx, best.Food)
	p.record(ctx, userID, decomposeUsage, callTypeParsePhoto, err)
	if err != nil {
		return Draft{}, fmt.Errorf("%w: decompose: %v", ErrParseFailed, err)
	}
	if len(ings) == 0 {
		return Draft{}, fmt.Errorf("%w: no ingredients", ErrParseFailed)
	}

	d := Draft{Name: best.Food, Servings: 1, Source: SourcePhoto}
	for _, ig := range ings {
		name := strings.TrimSpace(ig.Ingredient)
		if name == "" {
			continue
		}
		d.Ingredients = append(d.Ingredients, p.resolveIngredient(ctx, userID, name, ig.PortionEstimate))
	}
	if len(d.Ingredients) == 0 {
		return Draft{}, fmt.Errorf("%w: no usable ingredients", ErrParseFailed)
	}
	return d, nil
}

// resolveIngredient turns one extracted (name, portion phrase) into an
// IngredientInput. A name the index cannot match yields an UNRESOLVED input —
// kept verbatim, never guessed at, never dropped.
func (p *Parser) resolveIngredient(ctx context.Context, userID uuid.UUID, name, portion string) IngredientInput {
	in := IngredientInput{RawText: truncate(name, maxRawTextLen)}

	cands, err := p.foods.Resolve(ctx, userID, name, nil, resolveLimit)
	if err != nil || len(cands) == 0 {
		return in // unresolved
	}
	top := cands[0]
	id := top.Item.ID.String()
	in.FoodItemID = &id
	in.MatchScore = &top.MatchScore
	tier := top.MatchTier
	in.MatchTier = &tier
	// Display-only, for the review sheet — see IngredientInput.Name's own
	// comment. Left empty for the unresolved branch above.
	in.Name = top.Item.Name

	grams, assumed := portionGrams(portion, top.Item)
	in.Grams = grams
	in.PortionAssumed = assumed
	return in
}

// portionGrams converts a portion phrase into grams against the food's own
// units, falling back to the food's serving size and then to a flat estimate.
// The bool reports that the figure is a SYSTEM ESTIMATE, not a measurement —
// it must reach the UI, or a guess renders as fact (#138).
func portionGrams(portion string, item nutrition.FoodItem) (float64, bool) {
	if amount, unit, ok := units.ParsePhrase(portion); ok {
		if g, err := units.ResolveEntered(amount, unit, item.BaseUnit, item.ServingUnits); err == nil && g > 0 {
			return g, false
		}
	}
	return assumedPortionGrams(item)
}

// assumedPortionGrams is the portion to use when nothing measurable is
// available: the food's own serving size, else a flat estimate. The bool is
// always true — this figure is a SYSTEM ESTIMATE and must be labelled as one
// (#138). Shared with service.validate, so the parse path and the save path
// cannot drift on what an unmeasured portion means.
func assumedPortionGrams(item nutrition.FoodItem) (float64, bool) {
	if item.ServingGrams > 0 {
		return item.ServingGrams, true
	}
	return defaultAssumedGrams, true
}

// stripCodeFence removes a ```json … ``` wrapper some models add despite
// being told not to. Anything else is left untouched and will fail to
// unmarshal, which is the correct outcome.
func stripCodeFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
