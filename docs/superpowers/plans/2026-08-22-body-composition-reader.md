# PR A: Body-composition screenshot reader (kora#314)

Branch: `feat/314-body-composition-reader` off `main` (`0d9b7e00`).
Repo: `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`, Go API in `api/`.

## Spec (binding authority)

kora#314 plus its two comments, and `.planning/handoff/2026-08-22-body-composition.md`,
already read in full this session. Summarized rules below are the spec; this
plan is the argument. Where this plan and the rules below conflict, the rules
win.

1. Vision LLM (`gemini-3.5-flash`), not OCR. `gemini-3.5-flash-lite` 404s in
   asia-south1 (`api/internal/ai/providers/gemini.go:126`).
2. The uploaded image bytes are NEVER persisted — processed in memory,
   discarded. Comment at the point the bytes go out of scope in the handler
   saying so.
3. The model returns ONLY what is legible; NEVER infers or computes (no BMI,
   no fat-free mass, no derived anything). Absent = field omitted from JSON,
   which must decode to a Go **nil pointer**, never a zero value. Enforced in
   both the prompt AND the response schema (every field optional).
4. Content-hash cache stays: `sha256.Sum256(image)` keys the **result**, not
   the image. Mirrors `api/internal/ai/resolver.go:282` (`ResolvePhoto`).
5. New AI capability tag distinct from `identify_photo`, so spend is
   attributable. `agentgateway.go` pattern: `X-Kora-AI-Capability`.
6. Metered exactly like recipes: `billing.NewMeter(deps.DB)`,
   `withinBudget`/`recordCollected`/`ai.WithUsageCollector` — see
   `api/internal/recipes/parse.go`.
7. Model is `gemini-3.5-flash` (see #1).
8. Field set is EXACTLY what's in
   `api/internal/database/migrations/000039_body_composition.up.sql` and
   `api/internal/tracking/model.go`'s `BodyComposition` struct:
   `weight_kg, body_fat_pct, subcutaneous_fat_pct, visceral_fat_rating,
   skeletal_muscle_pct, muscle_mass_kg, body_water_pct, protein_pct,
   bone_mass_kg, scale_bmr_kcal`, plus a reading date (see below). Traps that
   MUST survive into the prompt/schema/tests:
   - `visceral_fat_rating` is a vendor RATING (Renpho bare `7`, Omron
     `7.5 level`, Tanita 1–59), never a percentage.
   - `skeletal_muscle_pct` and `muscle_mass_kg` are different quantities
     (Renpho reports both) — never derive one from the other.
   - `bone_mass_kg` is bone MASS, not bone DENSITY/BMD/T-score.
   - BMI, fat-free mass, fat mass in kg, metabolic age, qualitative bands
     ("Average"/"Excellent") must NEVER be returned.
   - Omron shows body fat as both `32.6 %` and `22.9 kg` — take the
     percentage only.
9. Reading date: the calendar date shown IN the screenshot, `YYYY-MM-DD`,
   omitted when not legible, never guessed as "today", never a timestamp.
10. `POST /v1/body-composition/read`, multipart `file`, wired next to the
    other AI routes behind the same auth (`v1` group,
    `auth.Middleware`+`user.ResolveMiddleware`, `internal/server/router.go`).
    Copy `resolve.Handler.ResolvePhoto`'s size discipline: `MaxBytesReader`
    before multipart parsing, 8 MiB cap, 413 on overflow,
    `http.DetectContentType` when the part has no Content-Type. `deps.Provider
    == nil` degrades (503-style, no panic) like recipes' parser-nil path.
11. Server-side plausibility validation: percentages outside 0–100,
    non-positive masses, weight outside a sane human range, a reading date in
    the future — DROP the offending field and report which were dropped.
    Never clamp.
12. 422 `unreadable` when nothing usable at all; 200 with whatever is legible
    otherwise (partial = success).
13. Downscale server-side before the provider call, using ONLY what's already
    in `go.mod` or stdlib. `golang.org/x/image` is NOT in `go.mod` or
    `go.sum` (verified) — implement a small stdlib-only nearest-neighbor
    resize rather than adding a dependency, and say so explicitly in the
    final report (this is the one place the issue anticipated a possible new
    dependency).
14. Tests per the parent task's list; mutation-check every new test (break
    it, confirm red, restore, report).
15. `//go:build smoke` live-provider test, N fixtures from an env-var
    directory, skips cleanly when unset. Never commit real screenshots.

## House rules (apply to every task)

- Immutable style: new values, not mutated inputs.
- Dense "why" comments at decision points, matching this repo's density.
- Files stay focused (extract rather than grow).
- Handle every error explicitly.
- Single-line conventional commit messages, no signature, no
  `Co-Authored-By`.
- Do NOT run prettier (Go-only work here, but the rule stands repo-wide).
- Table-driven tests, `testify/require`/`assert`, matching this repo's style
  (see `api/internal/recipes`, `api/internal/resolve`, `api/internal/ai`).

## Codebase facts implementers must use verbatim

- `ai.Provider` interface: `api/internal/ai/provider.go`. Every concrete
  implementation and EVERY test-double stub across the repo must implement
  any new interface method or the whole module fails to build. Known stub
  locations (from `grep -rn "func (.*) IdentifyPhoto("`):
  `cmd/api/main_test.go`, `internal/server/router_test.go`,
  `internal/coach/service_test.go` (3 stubs: `fakeProvider`,
  `errorProvider`, `recordingProvider`), `internal/recipes/parse_smoke_test.go`
  (`countingProvider`), `internal/recipes/parse_test.go` (`stubProvider`),
  `internal/recipes/parse_budget_test.go` (`slowFakeProvider`),
  `internal/ai/provider_test.go` (`stubProvider`),
  `internal/ai/usagesink_public_test.go` (`generationProvider`),
  `internal/ai/usage_outcome_test.go` (`depositingProvider`),
  `internal/ai/router_test.go` (`flakyPhotoProvider`, `stubProvider` — check
  both), plus the three real providers
  (`internal/ai/providers/{gemini,openai,agentgateway}.go`) and `Router`
  itself (`internal/ai/router.go`).
- `ai.Usage`, `ai.OutcomeOK/Error/Timeout`: `internal/ai/types.go`.
- Metrics call-type registry: `internal/metrics/labels.go` —
  `classByCallType` map, `classResolution`/`classDerived`. A call type not
  registered here silently buckets to `"other"`.
- Cache pattern to mirror: `internal/ai/resolver.go` around line 282
  (`ResolvePhoto`) — `sha256.Sum256(image)`, `CacheKey("photo", userID,
  hex.EncodeToString(sum[:]))`, `r.cache.Get`/`r.cache.Set`. The `Cache`
  interface is in `internal/ai/cache.go`.
- Meter pattern to mirror: `internal/recipes/parse.go` in full —
  `Parser.withinBudget`, `Parser.record`, `Parser.recordCollected`,
  `ai.WithUsageCollector`. `ai.Meter` interface:
  `internal/ai/resolver.go:86-89` (`Record`, `WithinBudget`).
  `billing.NewMeter(deps.DB)` returns something satisfying it structurally.
- Router policy to mirror exactly: `internal/ai/router.go`'s
  `IdentifyPhoto` (around line 288) plus its comment block on why there is
  no fallback, and `photoBudget`/`photoAttempts`/`photoRetryDelay`/
  `minRetryHeadroom`/`isTransientProviderError`/`hasRetryHeadroom`/
  `sleepWithin`. Pinning tests: `internal/ai/router_test.go:373-495`
  (`TestRouter_IdentifyPhoto_DoesNotFallBack`,
  `TestRouter_IdentifyPhoto_GivesPrimaryTheFullPhotoBudget`,
  `TestRouter_IdentifyPhoto_RetriesATransient503`,
  `TestRouter_IdentifyPhoto_DoesNotRetryARateLimit`).
- Handler size-cap pattern to mirror exactly: `internal/resolve/handler.go`
  `ResolvePhoto` — `maxPhotoBytes = 8 << 20`, `maxPhotoBodyBytes =
  maxPhotoBytes + 1<<10`, `http.MaxBytesReader` before `c.FormFile`,
  `errors.As(err, &mbe)` for `*http.MaxBytesError` -> 413, size check on
  `fileHeader.Size` -> 413, `http.DetectContentType` fallback. Pinning tests
  to mirror: `internal/resolve/handler_test.go`
  `TestResolvePhoto_TooLarge` / `TestResolvePhoto_BodyExceedsHardCap`
  (lines ~265-301), and the `buildMultipart`/`newEngine`/`newEngineNoUser`
  test helpers in that file.
- Server wiring pattern to mirror: `internal/server/router.go` lines
  ~240-256 (recipe parser nil-when-no-provider) and line ~136-137 (`v1 :=
  r.Group("/v1", auth.Middleware(deps.Verifier))`,
  `v1.Use(user.ResolveMiddleware(userRepo))`) — the new route goes in this
  `v1` group alongside `/recipes/parse` and `/resolve/*`.
- `tracking.BodyComposition` (the persistence-side struct, for field-name
  parity only — this PR does NOT write to it):
  `internal/tracking/model.go:60-99`.
- `go.mod` confirmed: `google.golang.org/genai v1.65.0`,
  `github.com/openai/openai-go v1.12.0`; NO `golang.org/x/image` anywhere in
  `go.mod` or `go.sum`.

## New package layout

```
api/internal/bodyread/
    downscale.go       // stdlib-only image resize
    downscale_test.go
    validate.go        // plausibility rules, dropped-field reporting
    validate_test.go
    service.go          // meter + hash cache + provider call + validation
    service_test.go
    handler.go           // HTTP: multipart parsing, size caps, status codes
    handler_test.go
    read_smoke_test.go   // //go:build smoke
```

## Task 1 — ai package: BodyCompositionReading type, Provider interface, Gemini implementation, metrics label, stub compilation

**Files:** `internal/ai/types.go`, `internal/ai/provider.go`,
`internal/ai/providers/gemini.go`, `internal/ai/providers/gemini_test.go`,
`internal/metrics/labels.go`, plus every stub file listed above under
"Codebase facts" that implements `ai.Provider` (add a compiling method to
each — copy `IdentifyPhoto`'s stub style in that file, returning zero
value/nil error unless a stub file already has bespoke error-returning stubs
for other methods, in which case match that file's existing pattern for a
method that isn't specifically under test there).

**In `internal/ai/types.go`**, add (verbatim field names/tags/order):

```go
// BodyCompositionReading is what a smart-scale screenshot legibly shows,
// read by a vision model (kora#314). Every field is a POINTER because
// absent must not collapse into zero — the same reasoning as
// tracking.BodyComposition (internal/tracking/model.go), which this
// mirrors field-for-field on purpose so a reading can be handed straight
// into that struct's shape without renaming.
//
// This type carries ONLY measured values. BMI, fat-free mass, fat mass in
// kg, metabolic age, and qualitative bands are structurally impossible to
// return here: there is no field for them, so a model that tries to supply
// one anyway has it silently dropped by encoding/json. See
// migrations/000039_body_composition.up.sql for why each is excluded.
type BodyCompositionReading struct {
	WeightKg *float64 `json:"weight_kg,omitempty"`
	BodyFatPct *float64 `json:"body_fat_pct,omitempty"`
	SubcutaneousFatPct *float64 `json:"subcutaneous_fat_pct,omitempty"`
	// VisceralFatRating is a vendor RATING, not a percentage — see the
	// struct doc on tracking.BodyComposition for the same warning. Never
	// render or validate this as a 0-100 percent.
	VisceralFatRating *float64 `json:"visceral_fat_rating,omitempty"`
	// SkeletalMusclePct and MuscleMassKg are DIFFERENT quantities (a scale
	// like Renpho reports both) — never derive one from the other.
	SkeletalMusclePct *float64 `json:"skeletal_muscle_pct,omitempty"`
	MuscleMassKg *float64 `json:"muscle_mass_kg,omitempty"`
	BodyWaterPct *float64 `json:"body_water_pct,omitempty"`
	ProteinPct *float64 `json:"protein_pct,omitempty"`
	// BoneMassKg is bone MASS, not bone DENSITY/BMD/T-score.
	BoneMassKg *float64 `json:"bone_mass_kg,omitempty"`
	// ScaleBMRKcal is the scale's own BMR estimate — comparison only, never
	// wired to Kora's own Mifflin-St Jeor target (see tracking.BodyComposition).
	ScaleBMRKcal *float64 `json:"scale_bmr_kcal,omitempty"`
	// ReadingDate is the calendar date the SCREENSHOT ITSELF shows for this
	// reading, "YYYY-MM-DD", nil when not legible. Never a timestamp, never
	// inferred as "today" — a reading may be days old by the time it's
	// uploaded (kora#314).
	ReadingDate *string `json:"reading_date,omitempty"`
}
```

**In `internal/ai/provider.go`**, add to the `Provider` interface (after
`IdentifyPhoto`, before `Decompose`):

```go
	// IdentifyBodyComposition reads a smart-scale result screenshot and
	// returns only what is legible — see BodyCompositionReading's doc
	// comment. A separate method from IdentifyPhoto because the response
	// shape is fundamentally different (one reading's worth of measured
	// numbers, not a list of food guesses) and cannot be forced into
	// []Guess.
	IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (BodyCompositionReading, Usage, error)
```

**In `internal/metrics/labels.go`**, add:

```go
	// Body-composition screenshot reads (POST /v1/body-composition/read).
	// A value not listed here disappears into labelOther — see the #81
	// lesson noted on the recipe call types just above.
	callIdentifyBodyComposition = "identify_body_composition"
```
registered in `classByCallType` as `classResolution` (same shape as an
identify: one user-initiated capture, headline spend, not derived).

**In `internal/ai/providers/gemini.go`:**
- New model constant is NOT needed — reuse `modelFlash` (already
  `"gemini-3.5-flash"`).
- New call type: `callTypeIdentifyBodyComposition = "identify_body_composition"`
  (mirrors `metrics.callIdentifyBodyComposition` — same string literal,
  duplicated as a literal the same way `callTypeParseRecipeText` etc. are
  duplicated between packages; do not import `metrics` from `ai/providers`).
- New system prompt constant `bodyCompositionSystemPrompt`, this exact text
  (it encodes every trap from the spec section above — do not paraphrase it
  away):

```go
const bodyCompositionSystemPrompt = "You read a smart body-composition " +
	"scale's result screen (for example Renpho, Omron, or Tanita) and " +
	"report ONLY the values that are clearly legible in the image. For " +
	"every field, if you cannot see it stated on screen, OMIT it entirely " +
	"— do not guess, do not estimate, and NEVER compute a value from other " +
	"values. Do not compute BMI from weight and height. Do not compute a " +
	"fat-free or lean mass from weight and body fat percentage. A value " +
	"you calculate rather than read is worse than no value at all. " +
	"Report weight in kilograms as weight_kg — convert from pounds if the " +
	"screen shows pounds (1 lb = 0.453592 kg); that is unit conversion of " +
	"a single displayed number, not inference of a new fact, so it is " +
	"fine. body_fat_pct is the body fat PERCENTAGE only — if the screen " +
	"also shows a fat mass in kilograms, ignore that number and report " +
	"only the percentage. visceral_fat_rating is the scale's own visceral " +
	"fat number exactly as displayed — usually a small bare number like 7, " +
	"or \"7.5 level\", or a value on a 1-59 scale. This is a VENDOR " +
	"RATING, not a percentage: report it even when the screen shows no " +
	"percent sign, and never treat it as one. skeletal_muscle_pct and " +
	"muscle_mass_kg are TWO DIFFERENT quantities, not the same number in " +
	"two units — some apps show both. Report each ONLY if its own value " +
	"is shown; never derive one from the other. bone_mass_kg is bone MASS " +
	"in kilograms as the scale reports it — this is NOT bone density, a " +
	"T-score, or a BMD number. If the screen shows only a density or " +
	"T-score, leave bone_mass_kg unset. body_water_pct and protein_pct are " +
	"percentages as shown. scale_bmr_kcal is the scale's own estimated " +
	"basal metabolic rate in kilocalories, if shown. reading_date is the " +
	"calendar date the screenshot itself displays for this reading — " +
	"scale apps almost always show one. Report it as YYYY-MM-DD. Omit it " +
	"if no date is legible on screen, and NEVER use today's date or any " +
	"date that is not actually printed on the screen. Do NOT report BMI, " +
	"fat-free mass, lean mass, fat mass in kilograms, metabolic age, or " +
	"any qualitative band or label such as \"Average\", \"Low\", \"High\", " +
	"or \"Excellent\" — these are derived or vendor opinion, not " +
	"measurements, and must never appear in your answer. Respond with " +
	"JSON only, matching the provided schema, using only the fields you " +
	"can actually read."
```

- New schema function `bodyCompositionResponseSchema() *genai.Schema`:
  `Type: genai.TypeObject`, one `genai.Schema{Type: genai.TypeNumber}`
  property per numeric field (`weight_kg`, `body_fat_pct`,
  `subcutaneous_fat_pct`, `visceral_fat_rating`, `skeletal_muscle_pct`,
  `muscle_mass_kg`, `body_water_pct`, `protein_pct`, `bone_mass_kg`,
  `scale_bmr_kcal`), one `genai.Schema{Type: genai.TypeString}` for
  `reading_date`. **No `Required` list** — every field must be omittable,
  which is the schema-level enforcement of rule #3 above. Doc-comment this
  choice explicitly (contrast with `guessResponseSchema`'s `Required` list
  and say why this one has none).
- New method:

```go
func (p GeminiProvider) IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (ai.BodyCompositionReading, ai.Usage, error) {
	data, usage, err := p.generateJSON(ctx, modelFlash, callTypeIdentifyBodyComposition,
		bodyCompositionSystemPrompt, []*genai.Part{genai.NewPartFromBytes(image, mime)}, bodyCompositionResponseSchema())
	if err != nil {
		return ai.BodyCompositionReading{}, usage, err
	}
	reading, err := parseBodyCompositionReading(data)
	if err != nil {
		return ai.BodyCompositionReading{}, usage, fmt.Errorf("gemini: identify body composition: parse response: %w", err)
	}
	return reading, usage, nil
}
```
- `parseBodyCompositionReading(data []byte) (ai.BodyCompositionReading, error)`:
  a pure `json.Unmarshal` into `ai.BodyCompositionReading`, mirroring
  `parseGuesses`/`parseIngredients` exactly (same doc-comment style: "pure
  function... unit-tested directly against hand-written sample JSON").
- Add `IdentifyBodyComposition` to `var _ ai.Provider = GeminiProvider{}` (no
  code change needed there, just confirm it still compiles).

**Gemini unit tests (`gemini_test.go`)** — this task owns the `parseGuesses`-
style tests for `parseBodyCompositionReading` only (pure function, no SDK):
- A JSON object missing several keys decodes to a reading with those fields
  `nil`, not zero-valued floats.
- A JSON object with an extra, unschemaed key (e.g. `"bmi": 24.1` or
  `"metabolic_age": 30`) decodes without error and WITHOUT populating
  anything — prove `encoding/json` drops unknown fields, which is the
  parse-layer half of rule #3's defense in depth (the schema is the other
  half, and is not independently testable without a live call — that's
  Task 5's smoke test).
- `visceral_fat_rating` of `7` (an integer-looking JSON number, no `%`
  anywhere in the payload) decodes into the same field as any other float —
  prove there is no separate percent-shaped parsing path that could
  misinterpret it.
- `reading_date` round-trips as a plain `"2026-08-20"` string, and a missing
  `reading_date` key decodes to `nil`.

**Batch stub update** (same dispatch, same commit or a clearly separate one
— implementer's call): add a compiling `IdentifyBodyComposition` method to
every stub file listed under "Codebase facts" so `go build ./...` and
`go vet ./...` succeed from `api/` when this task is done. Verify with
`cd api && go build ./... && go vet ./...` before reporting DONE — this is
the task's exit gate, not just running whatever code it touched.

**Model:** standard/mid-tier (multi-file coordination, but each edit is
mechanical once the shape is decided).

## Task 2 — OpenAI + AgentGateway provider implementations

**Depends on Task 1** (needs `ai.BodyCompositionReading`, the interface
method, and `parseBodyCompositionReading`... actually `parseBodyCompositionReading`
lives in `providers` package alongside `gemini.go` — OpenAI's implementation
can call it directly, same file scope, same as how `openai.go` calls
`parseGuesses`/`parseIngredients` defined in `gemini.go` today).

**Files:** `internal/ai/providers/openai.go`, `internal/ai/providers/openai_test.go`,
`internal/ai/providers/agentgateway.go`.

**In `openai.go`:**
- `bodyCompositionJSONSchema() map[string]any`: object root (no envelope
  needed — the reading IS the object, unlike the array-wrapped
  `guessJSONSchema`). Structured Outputs `strict:true` requires every
  property in `"required"` — OpenAI has no true-optional field under strict
  mode — so express "omittable" as **nullable type**: every property is
  `{"type": ["number", "null"]}` (or `["string", "null"]` for
  `reading_date`), and ALL are listed in `"required"` (required-but-nullable
  is how Structured Outputs expresses "must be present, may be null"; a
  model told in the prompt to answer `null` for anything unreadable
  satisfies both). `additionalProperties: false`. Doc-comment this
  explicitly — it looks contradictory next to "required" without the
  nullable-type context, and a future reader WILL trip on it the way the
  `guessJSONSchema` comment already anticipates for its own required list.
- `parseBodyCompositionReading` from `gemini.go` decodes this fine as-is:
  `encoding/json` sets a `*float64`/`*string` field to `nil` for a JSON
  `null` value exactly as it does for a missing key, so no OpenAI-specific
  unwrap step is needed (contrast with `unwrapGuesses` — there is no
  envelope here to unwrap).
- `IdentifyBodyComposition` method: same shape as `IdentifyPhoto` above it
  — `generateJSON` with `p.model`, `callTypeIdentifyBodyComposition`,
  `bodyCompositionSystemPrompt` (imported from `gemini.go`'s package-level
  const — same package, no import needed), an `ImageContentPart` built from
  a base64 `data:` URL exactly like `IdentifyPhoto` builds one, schema name
  `"body_composition_reading"`, `bodyCompositionJSONSchema()`. Then
  `parseBodyCompositionReading(data)` directly (no `unwrapGuesses`).
- Compat mode (`jsonObject == true`, used by NVIDIA-style fallbacks): falls
  out of `generateJSON`'s existing `buildParams` for free — no code change
  needed there, since it already branches on `p.jsonObject` generically.
  Confirm this in the task report rather than re-deriving it.

**In `agentgateway.go`:**
- Add a `bodyComposition OpenAIProvider` field to `AgentGatewayProvider`,
  constructed in `NewAgentGatewayProvider` via the existing `classified(...)`
  closure with capability `"identify_body_composition"` (must equal
  `providers.callTypeIdentifyBodyComposition` — same string, not imported,
  matching how `"identify_photo"` is duplicated as a literal there today)
  and context kind `"json_api"` (same context kind `IdentifyPhoto` uses,
  since this is still a single structured JSON response, not audio or
  embedding).
- `IdentifyBodyComposition` method: delegate to
  `p.bodyComposition.IdentifyBodyComposition(ctx, image, mime)`, wrap the
  returned `Usage` through `gatewayUsage` — same shape as every other
  delegating method in this file.

**Tests (`openai_test.go`):**
- `bodyCompositionJSONSchema()` shape: every property present, every one
  listed in `required`, `additionalProperties: false`, nullable types as
  specified above — assert on the map structure directly (this file already
  has a pattern for asserting on `guessJSONSchema()`'s map shape; find and
  mirror it).
- `buildParams`/`generateJSON` round-trip against a stub HTTP transport (or
  whatever this file's existing `TestOpenAIProvider_IdentifyPhoto`-equivalent
  uses) proving a response with some fields `null` decodes to a reading with
  those fields `nil`.
- A response containing an unschemaed extra key is dropped (same guarantee
  as Task 1's Gemini test, proven again here because the schema differs).

**Model:** standard/mid-tier.

## Task 3 — Router policy: IdentifyBodyComposition mirrors IdentifyPhoto exactly

**Depends on Task 1** (interface method must exist).

**Files:** `internal/ai/router.go`, `internal/ai/router_test.go`.

Add `func (r *Router) IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (BodyCompositionReading, Usage, error)`
with **identical policy** to `IdentifyPhoto`: primary only, no fallback,
`photoBudget`, retry once on a transient 503
(`isTransientProviderError`), never retry a rate limit, same
`hasRetryHeadroom`/`sleepWithin` gating.

Rather than duplicate `IdentifyPhoto`'s ~20-line retry loop verbatim (which
the house rules' "extract rather than grow" and general DRY practice argue
against once there are two identical loops), extract a generic helper:

```go
// retryPrimaryOnTransient runs call against the primary provider only,
// bounded by budget, retrying once on a transient error exactly as
// IdentifyPhoto documents above — no fallback, because [same reasoning:
// the deployed fallback for these two calls is not vision-capable].
// IdentifyBodyComposition shares this policy byte-for-byte with
// IdentifyPhoto, so both call through here rather than maintaining two
// copies of the same retry loop.
func retryPrimaryOnTransient[T any](ctx context.Context, budget time.Duration, call func(context.Context) (T, Usage, error)) (T, Usage, error) {
	// body: same loop currently inlined in IdentifyPhoto, generalized over T
}
```

Refactor `IdentifyPhoto` to call this helper too, so there is exactly one
implementation of the policy — **but only if doing so does not change
`IdentifyPhoto`'s existing observable behavior or break any of its pinning
tests** (`router_test.go:373-495`). Run those tests after the refactor,
not just the new ones, before reporting DONE. If the generic extraction
turns out awkward (e.g. the `usage.TokensIn += last.TokensIn` accumulation
across attempts is easiest to read inlined), leave `IdentifyPhoto` as-is and
give `IdentifyBodyComposition` its own copy of the loop instead — note that
decision in the task report rather than forcing an extraction that makes
either function harder to read.

**Tests (`router_test.go`)** — one per existing `IdentifyPhoto` pinning test,
same scenarios against `IdentifyBodyComposition`:
- `TestRouter_IdentifyBodyComposition_DoesNotFallBack` — primary errors,
  fallback never called, primary's real error surfaces.
- `TestRouter_IdentifyBodyComposition_GivesPrimaryTheFullPhotoBudget` —
  primary that sleeps past the old-broken 3s budget still succeeds.
- `TestRouter_IdentifyBodyComposition_RetriesATransient503` — one retry on
  503/UNAVAILABLE, succeeds on attempt 2, usage accumulates both attempts.
- `TestRouter_IdentifyBodyComposition_DoesNotRetryARateLimit` — 429 surfaces
  immediately, second call never happens.

The stub providers this file already has (`stubProvider`, `flakyPhotoProvider`)
need an `IdentifyBodyComposition` method to support these — either extend
`flakyPhotoProvider` with a second flaky method or add a
`flakyBodyCompositionProvider` alongside it; match whichever is less
duplicative once the file is open (a small generic-over-behavior test double
covering both call types is fine if it doesn't obscure the test itself).

**Model:** standard/mid-tier (touches shared router internals + pinning
tests).

## Task 4 — `bodyread` package: downscale, validation, service, handler, wiring

**Depends on Tasks 1–3** (needs the full `ai.Provider.IdentifyBodyComposition`
stack working end to end through `ai.Router`).

**New files**, `api/internal/bodyread/`:

### `downscale.go`
- `func downscaleForProvider(data []byte, mime string) ([]byte, string, error)`
  (name/shape implementer's call, but behavior is fixed): decode via
  `image.Decode` (blank-import `image/jpeg` and `image/png` for format
  registration — confirm both are what real scale-app screenshots use;
  Kora's mobile capture path already assumes one of these, check
  `apps/mobile` capture code only far enough to confirm, do not touch it).
  If the larger of width/height exceeds a `maxDimension` constant (use
  `1024`; comment why: "text is large and the background clean — #314's
  cost comment says this belongs in the first slice"), resize
  proportionally down to `maxDimension` on the long side using a hand-rolled
  nearest-neighbor sampler (loop `dst` pixels, map back to nearest `src`
  pixel, `image.NewRGBA` + `Set`). Re-encode as JPEG (`image/jpeg`,
  quality ~85) regardless of input format and return `"image/jpeg"` as the
  new mime — document that the output mime always changes to
  `image/jpeg` even for a PNG input, since callers must not assume the
  input mime survives. If decode fails (corrupt/unsupported format), return
  the ORIGINAL bytes and mime unchanged with no error — downscaling is an
  optimization, not a correctness requirement, and a decode failure here
  must not block a call that would otherwise succeed against the provider
  with the original bytes.
- Doc-comment at the top of the file: **why no `golang.org/x/image/draw`** —
  it is not in `go.mod`/`go.sum` (verified), and nearest-neighbor is
  sufficient here because the source is rendered UI text on a clean
  background, not a photograph where resampling quality matters. State
  plainly in the file that if a future caller needs high-quality
  interpolation, `golang.org/x/image` would need to be added as a new
  dependency — this file deliberately does not do that.

### `validate.go`
- `type DroppedField struct { Field string; Reason string }` (or similar —
  implementer's call on shape, but the service/handler need to report WHICH
  fields were dropped and WHY, per rule #11).
- `func validateReading(r ai.BodyCompositionReading, now time.Time) (ai.BodyCompositionReading, []DroppedField)`
  — returns a NEW reading (immutable style: do not mutate the input) with
  implausible fields set back to `nil`, plus the list of what was dropped.
  Rules (exact bounds — pick sane human ranges and justify each with a
  one-line comment, this is exactly the kind of magic-number spot the house
  rules want commented, not left bare):
  - Every `*_pct` field (`body_fat_pct`, `subcutaneous_fat_pct`,
    `skeletal_muscle_pct`, `body_water_pct`, `protein_pct`) must be in
    `[0, 100]`. **`visceral_fat_rating` is explicitly EXCLUDED from this
    check** — it is a vendor rating up to 59 on some scales (Tanita), not a
    percentage; validating it against 0-100 would be exactly the
    percent-vs-rating confusion rule #8 exists to prevent. Give
    `visceral_fat_rating` its own bound instead: non-negative, and below
    some generous ceiling (say 60, one above Tanita's documented max) —
    comment the ceiling's source.
  - `weight_kg`, `muscle_mass_kg`, `bone_mass_kg` must be `> 0`.
  - `weight_kg` additionally bounded to a sane human range — pick something
    like `[20, 300]` and comment it (20kg floor covers a low adult outlier
    without accepting a decimal-place misread like "1.82" for "18.2"; 300kg
    ceiling is a generous outlier bound, not a clinical judgment).
  - `scale_bmr_kcal` must be `> 0` (a BMR of 0 or negative is not a
    measurement).
  - `reading_date`: parse as `"2006-01-02"`; a value that fails to parse OR
    is strictly after `now`'s calendar date (compare dates, not
    instants — a same-day reading captured in the evening must not be
    dropped for being "in the future" relative to a `now` earlier in the
    same day if `now` carries a time component, so truncate both to
    `YYYY-MM-DD` before comparing) is dropped.
  - Every drop appends a `DroppedField` naming the field and a short
    human-readable reason (e.g. `"body fat 182% outside 0-100 range"`),
    which the handler surfaces in the response so a client can show the
    user what was silently omitted.

### `service.go`
- `type Reader struct` holding: `provider ai.Provider`, `foods` NOT needed
  (no nutrition lookup here — this endpoint reads and returns, never
  touches `nutrition.Repository`), `cache ai.Cache` (reuse the SAME `Cache`
  interface `internal/ai/cache.go` defines — do not invent a second cache
  abstraction), `meter ai.Meter`.
- `NewReader(provider ai.Provider, cache ai.Cache, meter ai.Meter) *Reader`
  — mirrors `recipes.NewParser`'s constructor shape and its doc comment
  about the meter being REQUIRED (copy that reasoning, adapted).
- `type Result struct { Reading ai.BodyCompositionReading; Dropped []DroppedField; Unreadable bool }`
  — `Unreadable` is true when nothing at all survived validation (every
  field nil after validation, including no reading date) — the handler maps
  this to 422; anything else (including a reading with SOME nil fields) is
  200.
- `func (s *Reader) Read(ctx context.Context, userID uuid.UUID, image []byte, mime string) (Result, error)`:
  1. **Downscale first** (`downscaleForProvider`) — cheapest lever, and it
     changes what gets hashed, so the cache key must be computed on the
     downscaled bytes (not the original), matching what actually gets sent
     to the provider on a miss. Comment this ordering choice.
  2. Compute `sha256.Sum256` of the (downscaled) bytes, build a cache key —
     reuse `ai.CacheKey`'s helper if it's exported (check `internal/ai/cache.go`
     and `resolver.go` for how `CacheKey("photo", userID, hex...)` is
     constructed; use a DISTINCT first-argument kind string, e.g.
     `"body_composition"`, so this never collides with `ResolvePhoto`'s
     `"photo"` cache entries for a coincidentally-identical image).
  3. Cache hit -> return its `Result` directly, no provider call, no meter
     check (mirrors `resolve` in `resolver.go`: cache is checked BEFORE the
     budget check, since a cache hit costs nothing to serve).
  4. Cache miss -> `withinBudget` (mirrors `recipes.Parser.withinBudget`,
     returns a sentinel error the handler maps to 429 — define
     `ErrBudgetExhausted` in this package, same pattern as recipes').
  5. Call `provider.IdentifyBodyComposition` through `ai.WithUsageCollector`
     + `recordCollected`-equivalent metering, call type
     `callTypeIdentifyBodyComposition` (define locally in this package,
     matching the string used in `providers`/`metrics` — do not import
     `providers`, duplicate the literal the same way `recipes` does).
  6. **This is the point the image bytes go out of scope** — after the
     provider call returns, nothing in this function holds a reference to
     `image` any longer once `Read` returns. Put the required "never
     cached/stored to disk" comment HERE, at the last line that touches the
     `image` parameter, worded so it reads as a standing warning:
     e.g. `// image is never written to disk or any persistent store beyond
     this point — do not add caching-to-disk here; the CACHE above stores
     only the parsed Result, never the bytes.`
  7. Validate (`validateReading`) with `time.Now()`.
  8. Set `Unreadable` when the validated reading has every field nil.
  9. Cache the `Result` (not the raw reading pre-validation — cache the
     final, validated answer, so a cache hit never resurrects a dropped
     implausible value).
  10. A provider error is NOT the same as "unreadable" — a provider error
      (timeout, 5xx, etc.) propagates as a real Go error the handler maps to
      a 5xx/502, distinct from the 422 `unreadable` path, which only fires
      when the provider ANSWERED but nothing in the answer survived
      validation. Get this distinction right; it's tested explicitly.

### `handler.go`
- `type Handler struct { reader *Reader }`, `NewHandler(reader *Reader) Handler`.
  If `deps.Provider == nil` at wiring time, the server passes a `nil`
  `*Reader` into `NewHandler` the same way `recipes.NewHandler(recipeSvc,
  recipeParser)` accepts a nil `*Parser` — `Handler.Read` checks `h.reader
  == nil` first and responds `503 unavailable` (manual entry still works;
  match `recipes.Handler.Parse`'s exact nil-check pattern — read that
  function before writing this one).
- `func (h Handler) Read(c *gin.Context)`:
  1. `user.IDFromContext(c)` -> 401 `unauthorized` on failure (exact copy
     of `resolve.Handler.ResolvePhoto`'s opening block).
  2. `nil` reader -> 503.
  3. `http.MaxBytesReader` BEFORE `c.FormFile` (constants:
     `maxImageBytes = 8 << 20`, `maxImageBodyBytes = maxImageBytes + 1<<10`
     — same numbers as `resolve.maxPhotoBytes`, defined locally in this
     package rather than imported, since `resolve`'s constants are
     unexported).
  4. `c.FormFile("file")` -> `errors.As(err, &mbe)` -> 413
     `payload_too_large`; any other FormFile error (including no file at
     all) -> 400 `invalid_input`.
  5. `fileHeader.Size > maxImageBytes` -> 413.
  6. Read bytes, `mime := fileHeader.Header.Get("Content-Type")`, fallback
     `http.DetectContentType(buf)` when empty — exact copy of
     `resolve.Handler.ResolvePhoto`'s tail.
  7. Call `h.reader.Read(ctx, uid, buf, mime)`.
  8. Provider/service error -> `httpx.RespondServiceError` (matches every
     other handler in this repo) UNLESS the error is
     `ai.ErrBudgetExhausted`-equivalent (this package's own budget-exhausted
     sentinel from `service.go`), which maps to 429 the same way
     `recipes.Handler.Parse` maps `recipes.ErrBudgetExhausted` — read that
     handler for the exact status/body shape and match it.
  9. `result.Unreadable` -> 422 with a stable body
     `{"error": "unreadable", "message": "..."}` (use `httpx.Error` the
     same way every other 4xx in this repo is built — check `httpx.Error`'s
     signature before writing this).
  10. Otherwise 200, body includes the reading AND the dropped-fields list
      (both must reach the client — PR B's confirm form needs to know what
      was silently omitted so it can tell the user, per rule #11). Response
      shape: reuse `httpx.OK(c, result)` if `Result`'s JSON tags already say
      what's needed, or define a small response DTO if `Result`'s internal
      shape (e.g. `Unreadable bool`) shouldn't leak into the wire format —
      implementer's call, but the wire response MUST include the reading's
      fields at top level or under a clearly-named key, plus a
      `dropped_fields` (or similarly named) array, so PR B can bind to it
      directly. Match `httpx`'s existing envelope conventions (check
      `resolve` and `recipes` handlers for the shape `httpx.OK` produces).

### Server wiring — `internal/server/router.go`

Mirror the recipe-parser wiring block (~line 240-256) exactly in spirit:

```go
var bodyCompositionHandler bodyread.Handler
if deps.Provider != nil {
	bodyReader := bodyread.NewReader(deps.Provider, deps.ResolveCache, billing.NewMeter(deps.DB))
	bodyCompositionHandler = bodyread.NewHandler(bodyReader)
} else {
	bodyCompositionHandler = bodyread.NewHandler(nil)
}
v1.POST("/body-composition/read", bodyCompositionHandler.Read)
```

(Check what `deps.ResolveCache` actually is / whether it satisfies
`ai.Cache` — grep `router.go` for `ResolveCache` and `resolveGeneration`
near the admin handler wiring already read this session, and for
`deps.Provider`'s exact type. If no existing `ai.Cache` instance is
reachable from `Deps` for reuse, check `cmd/api/main.go` for how the
resolver's cache is constructed and either reuse that same instance via a
new `Deps` field or construct an equivalent one here — do NOT build a
second, divergent caching implementation.) Route placement: alongside
`/recipes/parse` and `/resolve/*`, inside the same `v1` group (auth +
tenant resolution already applied there).

### Tests

`downscale_test.go`: an oversized synthetic image (generate one in-test with
`image.NewRGBA`, don't load a fixture) downscales to `<= maxDimension` on
its long side and decodes back to a valid JPEG; an image already under the
threshold is returned unchanged (same bytes, same mime) — do not
re-encode/re-compress an image that doesn't need resizing, since that would
be a lossy no-op; a corrupt input returns the original bytes/mime and no
error.

`validate_test.go` (table-driven): each plausibility rule above gets a case
that drops (out-of-range percent, non-positive mass, out-of-range weight,
future date, unparseable date string) and a case that keeps (boundary
values 0 and 100 for percentages are VALID, not dropped — confirm off-by-one
boundaries explicitly); `visceral_fat_rating` at a value like 45 is kept
(would be dropped if the code mistakenly applied the 0-100 percent rule to
it — this is the trap test for rule #8, make it fail loudly if that bug is
introduced); a reading where every field is dropped is reported as fully
empty (feeds the `Unreadable` check in `service_test.go`, but is validate's
own concern to prove).

`service_test.go` (stub `ai.Provider`, `ai.Cache`, `ai.Meter`):
- Absent fields (provider returns a reading with only `WeightKg` set) yield
  a `Result` with every other field nil — NEVER zero.
- A provider JSON response hand-constructed with extra keys the schema
  doesn't define (simulate via a stub provider that returns a
  `BodyCompositionReading` — since Go's struct already can't carry
  unschemaed fields, this specific guarantee is really Task 1/2's parse-test
  territory; if there's nothing new to prove at the service layer beyond
  what Tasks 1/2 already covered, DON'T write a redundant test here — note
  that call in the report instead of padding coverage).
- `visceral_fat_rating` from the provider survives validation unmodified
  when in a rating-typical range like 7 or 45.
- Implausible values are dropped AND reported in `Result.Dropped`.
- Reading date: present and valid -> parsed through; absent -> nil, no drop
  entry; future date -> dropped, WITH a drop entry.
- A byte-identical second call (same image bytes) hits the cache: assert the
  stub provider's call counter stays at 1.
- A call over quota (stub meter's `WithinBudget` returns `false`) never
  reaches the provider: assert the stub provider's call counter stays at 0,
  and the returned error is the package's `ErrBudgetExhausted`.
- A provider that returns a reading with literally everything nil (nothing
  legible at all) yields `Result.Unreadable == true`.
- A provider that returns SOME legible fields, even if others get dropped by
  validation, yields `Result.Unreadable == false` (partial = success, rule
  #12 — this is the test that would catch someone accidentally treating "had
  some drops" as "unreadable").

`handler_test.go` (mirror `resolve/handler_test.go`'s helpers —
`newEngine`/`newEngineNoUser`/`buildMultipart` equivalents, adapted to this
package's single route):
- 401 unauthenticated (no user in context).
- 400 no file part.
- 413 oversized — BOTH variants, matching `TestResolvePhoto_TooLarge` (part
  size exceeds `maxImageBytes` but body stays under the hard cap) AND
  `TestResolvePhoto_BodyExceedsHardCap` (body genuinely exceeds
  `maxImageBodyBytes`, tripping `MaxBytesReader` mid-read) — write BOTH,
  they exercise different code paths per the resolve package's own comments.
- 422 `unreadable` when the stub reader returns `Result{Unreadable: true}`.
- 200 with a partial reading when the stub reader returns some-fields-nil
  plus a non-empty `Dropped` list — assert the response body actually
  carries both the reading and the dropped-fields list.
- 503 when the handler is constructed with a nil reader.
- 429 when the reader returns `ErrBudgetExhausted`.

**Mutation-check** every test above per the parent task's hard requirement:
for each, break the corresponding production code (flip a comparison,
remove a nil-guard, swap a status code), confirm the test goes red, restore
the code, confirm green again. Report the full list of what was
mutation-checked and the outcome for each in the task report — this is
checked by the task reviewer.

**Model:** most capable available (multi-file new package, cross-cutting
wiring, the most design judgment of any task in this plan — get this one
reviewed carefully).

## Task 5 — Live-provider smoke test

**Depends on Task 4.**

**File:** `api/internal/bodyread/read_smoke_test.go`, `//go:build smoke`.

Mirror `internal/recipes/parse_smoke_test.go`'s two-test structure
(direct-provider test + through-Router test) adapted:
- Skip cleanly (`t.Skip`) when a chosen env var (e.g.
  `KORA_BODY_COMP_FIXTURES_DIR`) is unset — do NOT gate on `GEMINI_API_KEY`
  alone, since this test also needs real fixture images and their expected
  values, which `GEMINI_API_KEY`-gating alone doesn't provide. Gate on BOTH:
  skip if either `GEMINI_API_KEY` or the fixtures-dir env var is unset.
- Document the expected fixture directory layout in a comment at the top of
  the file, e.g.: one subdirectory per scale app (`renpho/`, `omron/`, at
  least these two per rule #15's "at least two different scale apps"), each
  containing an image file plus a sidecar JSON or a naming convention
  (implementer's call, but pick ONE clear convention and document it) giving
  the expected values to assert loosely against (e.g. weight within ±0.5kg,
  body fat pct present and within a documented range) — LOOSE assertions,
  since a live model's exact output isn't pinned, but the test must still
  prove: something legible came back, at least `weight_kg` is populated for
  a screenshot that clearly shows weight, `visceral_fat_rating` (when the
  fixture is known to show one) is NOT treated as a percentage-range value,
  and the reading date (when the fixture's sidecar says one is expected) is
  parsed.
- Iterate every fixture found under the directory (glob), not a single
  hardcoded path — "design the smoke test to take N fixtures" per rule #15.
- Explicitly state in a code comment: real scale screenshots are personal
  health data and MUST NOT be committed to this repo; this test only reads
  from the env-var-pointed local directory and the directory itself must
  stay outside version control (do not add a fixtures directory under
  `api/` even as an empty placeholder with a `.gitkeep` — that would invite
  someone to drop real screenshots into a tracked path).

**Model:** standard/mid-tier — mechanical once the fixture convention is
picked, matching the existing smoke test's shape closely.

## Final steps (controller, not a dispatched task)

1. From `api/`: `go build ./...`, `go vet ./...`, `go test ./...` (excluding
   the smoke tag, which is the default since it's gated behind
   `//go:build smoke`) — capture and report the ACTUAL output, not a
   paraphrase.
2. Final whole-branch code review per the subagent-driven-development skill,
   most capable model, pointed at the ledger's parked/deferred findings.
3. `gh pr create` — title referencing kora#314, body stating: the design
   (provider method, schema, prompt, validation rules), explicit
   NOT-in-scope list (the mobile/React Native confirm flow — that's PR B;
   InBody/DEXA — that's slice 4), the mutation-check summary, and any
   decisions this plan left to the implementer's judgment (surface them
   verbatim from task reports rather than re-deciding silently).
4. Report back to the user: provider method signature, response schema
   (both Gemini and OpenAI shapes), the exact system prompt text, the
   validation rules with their bounds, mutation-check results per test, and
   every decision an implementer made that this plan left open (the
   downscale threshold's exact value if changed, the cache-key kind string,
   the response DTO shape, whether `IdentifyPhoto`'s retry loop was
   refactored or left duplicated, the wiring's cache-reuse resolution).
