//go:build smoke

package bodyread

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
)

// Fixture directory layout (KORA_BODY_COMP_FIXTURES_DIR):
//
//	$KORA_BODY_COMP_FIXTURES_DIR/
//	  renpho/
//	    001/
//	      image.jpg          (or .jpeg / .png — any of these three)
//	      expected.json
//	    002/
//	      image.png
//	      expected.json
//	  omron/
//	    001/
//	      image.jpg
//	      expected.json
//
// One subdirectory per scale app (kora#314's acceptance criterion needs
// proof against at least Renpho and Omron, the two apps the schema was
// measured off — see BodyCompositionReading's doc comment in
// internal/ai/types.go). Under each app directory, one subdirectory per
// fixture case, each holding exactly one image file named "image" with
// extension .jpg, .jpeg, or .png, plus a sidecar "expected.json" giving the
// values a real model call should recover. Every field in expected.json is
// OPTIONAL — omit whatever the screenshot does not legibly show, and this
// test only asserts the fields that are present:
//
//	{
//	  "weight_kg": 82.4,               // asserted within ±0.5kg
//	  "visceral_fat_rating_present": true, // asserted non-nil, NOT range-checked
//	  "reading_date": "2026-08-12"      // asserted present and equal
//	}
//
// This test walks every "expected.json" found anywhere under the directory
// (via filepath.WalkDir), so adding a fixture is just adding a new
// subdirectory — no code change and no hardcoded path.
//
// Real scale screenshots are personal health data (weight, body-fat
// percentage, and similar) and MUST NEVER be committed to this repository.
// This test reads ONLY from the local, non-repo directory named by
// KORA_BODY_COMP_FIXTURES_DIR — it does not ship any fixtures, and no
// placeholder directory (not even an empty one with a .gitkeep) exists
// under api/ for this purpose, on purpose: a tracked placeholder is an
// invitation for someone to drop real screenshots into a path git watches.
// Set up your own fixtures directory outside this repo to run this test.

// fixtureExpectation is the sidecar JSON shape described above. Every field
// is a pointer/zero-value-omittable so "not documented for this fixture"
// and "documented as absent" stay distinguishable — same reasoning as
// ai.BodyCompositionReading itself.
type fixtureExpectation struct {
	WeightKg                 *float64 `json:"weight_kg,omitempty"`
	VisceralFatRatingPresent bool     `json:"visceral_fat_rating_present,omitempty"`
	ReadingDate              string   `json:"reading_date,omitempty"`
	// AbsentFields names ai.BodyCompositionReading JSON keys that this
	// fixture's screenshot does NOT legibly show and which must therefore
	// come back nil on every run. "not documented" (the field simply
	// absent from this slice) stays distinguishable from "documented as
	// absent" (named here) — same distinction the struct's own doc comment
	// draws for the reading itself. This is deliberately the strongest
	// assertion this test can make: it catches exactly the two traps
	// kora#314 exists to prevent — a scale's skeletal-muscle-mass kg figure
	// leaking into muscle_mass_kg, and date TEXT invented for a screen that
	// shows none (use "reading_date_text" here, not "reading_date" — the
	// model only ever reports the former; see
	// bodyCompositionResponseSchema in gemini.go).
	AbsentFields []string `json:"absent_fields,omitempty"`
}

// weightToleranceKg is how far a live model's read weight may drift from a
// fixture's documented value and still count as correct. Loose on purpose —
// this test pins "the model can read a scale screenshot," not "the model
// reads to sub-gram precision."
const weightToleranceKg = 0.5

// bodyCompFixture is one discovered fixture: its image bytes, MIME type, and
// documented expectations.
type bodyCompFixture struct {
	label    string // e.g. "renpho/001", used in test failure output
	image    []byte
	mime     string
	expected fixtureExpectation
}

// loadBodyCompFixtures walks dir for every "expected.json" sidecar and pairs
// it with the "image.*" file in the same directory. Fails the test (rather
// than skipping) if a sidecar has no matching image, or an image extension
// is not one this test knows how to MIME-type — a malformed fixture
// directory should be loud, not silently skipped, since a silent skip could
// hide the exact live-model verification this test exists to provide.
func loadBodyCompFixtures(t *testing.T, dir string) []bodyCompFixture {
	t.Helper()

	var fixtures []bodyCompFixture
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Name() != "expected.json" {
			return nil
		}

		fixtureDir := filepath.Dir(path)
		label, relErr := filepath.Rel(dir, fixtureDir)
		if relErr != nil {
			label = fixtureDir
		}

		raw, readErr := os.ReadFile(path)
		require.NoError(t, readErr, "reading sidecar for fixture %s", label)

		var expected fixtureExpectation
		require.NoError(t, json.Unmarshal(raw, &expected), "parsing sidecar for fixture %s", label)

		imagePath, mime := findFixtureImage(t, fixtureDir, label)
		imageBytes, imgErr := os.ReadFile(imagePath)
		require.NoError(t, imgErr, "reading image for fixture %s", label)

		fixtures = append(fixtures, bodyCompFixture{
			label:    label,
			image:    imageBytes,
			mime:     mime,
			expected: expected,
		})
		return nil
	})
	require.NoError(t, err, "walking fixtures directory %s", dir)

	return fixtures
}

// findFixtureImage locates the "image.*" file in fixtureDir and returns its
// path and MIME type. Fails the test if none of the three supported
// extensions is present.
func findFixtureImage(t *testing.T, fixtureDir, label string) (path, mime string) {
	t.Helper()

	candidates := map[string]string{
		"image.jpg":  "image/jpeg",
		"image.jpeg": "image/jpeg",
		"image.png":  "image/png",
	}
	for name, m := range candidates {
		p := filepath.Join(fixtureDir, name)
		if _, err := os.Stat(p); err == nil {
			return p, m
		}
	}
	t.Fatalf("fixture %s: no image.jpg/.jpeg/.png found alongside expected.json", label)
	return "", ""
}

// bodyCompProvider builds the live provider this test drives. Mirrors
// cmd/api/main.go's buildResolveHandler: Vertex is preferred whenever
// VERTEX_PROJECT is set (project-scoped capacity/quota, no shared free-tier
// pool — see NewVertexProvider's doc comment), falling back to a Gemini API
// key, and t.Skip when NEITHER is configured. The free-tier key's 20
// calls/day quota made a clean measurement impossible (see kora#314), which
// is why Vertex support exists here at all — it must be tried FIRST, not
// merely supported, or every run keeps silently preferring the exhausted
// key over the working credential.
func bodyCompProvider(t *testing.T, ctx context.Context) (providers.GeminiProvider, bool) {
	t.Helper()

	project := os.Getenv("VERTEX_PROJECT")
	apiKey := os.Getenv("GEMINI_API_KEY")
	switch {
	case project != "":
		provider, err := providers.NewVertexProvider(ctx, project, os.Getenv("VERTEX_LOCATION"))
		require.NoError(t, err)
		return provider, true
	case apiKey != "":
		provider, err := providers.NewGeminiProvider(ctx, apiKey)
		require.NoError(t, err)
		return provider, true
	default:
		return providers.GeminiProvider{}, false
	}
}

// defaultBodyCompSmokeRuns is how many times each fixture is read per test
// invocation. kora#314's actual bug (never set temperature) made the model
// answer correctly on roughly 1 call in 3 — a test that calls the provider
// ONCE, as this test originally did, has a real chance of passing on a
// lucky draw against a broken prompt/schema/temperature, which is exactly
// how the original PR merged with the defect intact. Repetition is what
// turns "usually reads everything" into a test failure instead of a
// silent, luck-dependent pass — every run of every fixture must satisfy
// its expectations, not just the majority.
const defaultBodyCompSmokeRuns = 3

// bodyCompSmokeRuns reads KORA_BODY_COMP_SMOKE_RUNS to let a slower/more
// thorough verification pass (per this task's "5 consecutive runs"
// acceptance bar) override the default without editing code.
func bodyCompSmokeRuns(t *testing.T) int {
	t.Helper()
	raw := os.Getenv("KORA_BODY_COMP_SMOKE_RUNS")
	if raw == "" {
		return defaultBodyCompSmokeRuns
	}
	n, err := strconv.Atoi(raw)
	require.NoError(t, err, "KORA_BODY_COMP_SMOKE_RUNS must be an integer")
	require.Greaterf(t, n, 0, "KORA_BODY_COMP_SMOKE_RUNS must be positive, got %d", n)
	return n
}

// TestBodyComposition_Smoke makes several real Gemini calls per discovered
// fixture (see bodyCompSmokeRuns) and asserts the live model's answer
// against each fixture's documented expectations on EVERY run.
//
// This exists because every other test in this package drives a stub that
// returns exactly the JSON the test asked for — proving decoding and
// validation, but assuming away the part most likely to break: whether the
// real prompt and schema actually get a real vision model to read a real
// scale screenshot correctly. This test calls ai.Provider directly (not
// bodyread.Reader) — validation is bodyread's job and is already covered by
// validate_test.go; this test is provider+prompt+schema only.
//
// Excluded from `go test ./...` (needs `-tags smoke`) and gated on BOTH a
// live credential (VERTEX_PROJECT or GEMINI_API_KEY — see bodyCompProvider)
// and KORA_BODY_COMP_FIXTURES_DIR, so it never runs by accident and never
// runs against a directory that doesn't exist.
func TestBodyComposition_Smoke(t *testing.T) {
	ctx := context.Background()
	provider, configured := bodyCompProvider(t, ctx)
	fixturesDir := os.Getenv("KORA_BODY_COMP_FIXTURES_DIR")
	if !configured || fixturesDir == "" {
		t.Skip("VERTEX_PROJECT (or GEMINI_API_KEY) and KORA_BODY_COMP_FIXTURES_DIR must both be set; skipping live body-composition smoke test")
	}

	fixtures := loadBodyCompFixtures(t, fixturesDir)
	require.NotEmpty(t, fixtures, "fixtures directory %s contained no expected.json sidecars", fixturesDir)

	runs := bodyCompSmokeRuns(t)

	for _, fx := range fixtures {
		fx := fx
		t.Run(fx.label, func(t *testing.T) {
			for run := 1; run <= runs; run++ {
				run := run
				t.Run("run"+strconv.Itoa(run), func(t *testing.T) {
					reading, _, err := provider.IdentifyBodyComposition(ctx, fx.image, fx.mime)
					require.NoError(t, err, "a real model call must succeed for a legible scale screenshot")

					assertBodyCompReading(t, fx, reading)
				})
			}
		})
	}
}

// assertBodyCompReading holds the loose, shared assertions both
// TestBodyComposition_Smoke and TestBodyComposition_ThroughRouter_Smoke
// apply to a live reading. Loose on purpose: an exact live-model answer
// isn't pinned, but each assertion still proves something real did come
// back rather than the response being silently empty or mis-shaped.
func assertBodyCompReading(t *testing.T, fx bodyCompFixture, reading ai.BodyCompositionReading) {
	t.Helper()

	// Logged FIRST (before any assertion can fail the test early) and with
	// every field, not just the three that get range/equality checks below
	// — a failure needs the full picture to tell "one field wrong" apart
	// from "the model silently reverted to reporting almost nothing", which
	// is the actual kora#314 failure mode this test exists to catch.
	// resolveReadingDateText is called here, not by the provider — this test
	// drives ai.Provider directly (see this function's own doc comment), so
	// the resolution step bodyread.Reader.Read normally performs has to be
	// simulated explicitly to assert on a resolved date at all. Real
	// production traffic goes through Reader.Read, which does this exact
	// call (service.go).
	resolvedDate := resolveReadingDateText(reading.ReadingDateText, time.Now())

	t.Logf("fixture %s: weight=%v body_fat_pct=%v subq=%v visceral=%v skel_pct=%v muscle_kg=%v water=%v protein=%v bone=%v bmr=%v reading_date_text=%v resolved_reading_date=%v",
		fx.label, derefFloat(reading.WeightKg), derefFloat(reading.BodyFatPct), derefFloat(reading.SubcutaneousFatPct),
		derefFloat(reading.VisceralFatRating), derefFloat(reading.SkeletalMusclePct), derefFloat(reading.MuscleMassKg),
		derefFloat(reading.BodyWaterPct), derefFloat(reading.ProteinPct), derefFloat(reading.BoneMassKg),
		derefFloat(reading.ScaleBMRKcal), derefString(reading.ReadingDateText), derefString(resolvedDate))

	if fx.expected.WeightKg != nil {
		require.NotNil(t, reading.WeightKg, "fixture %s: weight_kg expected but not returned", fx.label)
		diff := *reading.WeightKg - *fx.expected.WeightKg
		if diff < 0 {
			diff = -diff
		}
		require.LessOrEqualf(t, diff, weightToleranceKg,
			"fixture %s: weight_kg %.2f too far from expected %.2f", fx.label, *reading.WeightKg, *fx.expected.WeightKg)
	}

	if fx.expected.VisceralFatRatingPresent {
		// The point here is NOT range-checking — VisceralFatRating is a
		// vendor rating, not a percentage (see BodyCompositionReading's doc
		// comment), and validating it as 0-100 is explicitly bodyread's
		// mistake to not make, not this test's. This only proves the field
		// decoded and was not silently dropped.
		require.NotNil(t, reading.VisceralFatRating,
			"fixture %s: visceral_fat_rating expected but not returned", fx.label)
	}

	if fx.expected.ReadingDate != "" {
		require.NotNil(t, resolvedDate, "fixture %s: reading_date_text expected to resolve but did not (raw text %v)", fx.label, derefString(reading.ReadingDateText))
		require.Equal(t, fx.expected.ReadingDate, *resolvedDate, "fixture %s: resolved reading_date mismatch", fx.label)
		_, parseErr := time.Parse("2006-01-02", *resolvedDate)
		require.NoError(t, parseErr, "fixture %s: resolved reading_date %q must parse as YYYY-MM-DD", fx.label, *resolvedDate)
	}

	for _, name := range fx.expected.AbsentFields {
		present, ok := bodyCompFieldPresent(reading, name)
		require.Truef(t, ok, "fixture %s: absent_fields names unknown field %q", fx.label, name)
		require.Falsef(t, present,
			"fixture %s: %s expected ABSENT (not legible on this screen) but the model returned a value — "+
				"this is the exact fabrication/conflation kora#314 exists to prevent", fx.label, name)
	}
}

// TestBodyComposition_ThroughRouter_Smoke drives the SAME construction
// main.go's directProviders builds — Gemini primary behind ai.Router — to
// prove the photoBudget (which IdentifyBodyComposition shares with
// IdentifyPhoto, see router.go's doc comment on IdentifyBodyComposition) is
// wide enough for a real body-composition call, not just an
// IdentifyPhoto-style single-guess vision call. TestBodyComposition_Smoke
// above only proves the raw provider works; this proves the budget the
// Router actually enforces in production doesn't starve it.
func TestBodyComposition_ThroughRouter_Smoke(t *testing.T) {
	ctx := context.Background()
	gemini, configured := bodyCompProvider(t, ctx)
	fixturesDir := os.Getenv("KORA_BODY_COMP_FIXTURES_DIR")
	if !configured || fixturesDir == "" {
		t.Skip("VERTEX_PROJECT (or GEMINI_API_KEY) and KORA_BODY_COMP_FIXTURES_DIR must both be set; skipping live router body-composition smoke test")
	}

	fixtures := loadBodyCompFixtures(t, fixturesDir)
	require.NotEmpty(t, fixtures, "fixtures directory %s contained no expected.json sidecars", fixturesDir)

	// Fallback must be a DISTINCT, counting provider so a budget regression
	// (primary killed too early) is visible rather than papered over by the
	// fallback quietly answering instead — same reasoning as
	// recipes.TestParseText_ThroughRouter_Smoke's countingProvider.
	fallback := &countingBodyCompFallback{}
	router := &ai.Router{Primary: gemini, Fallback: fallback}

	for _, fx := range fixtures {
		fx := fx
		t.Run(fx.label, func(t *testing.T) {
			start := time.Now()
			reading, _, err := router.IdentifyBodyComposition(ctx, fx.image, fx.mime)
			elapsed := time.Since(start)

			require.NoError(t, err, "a real model call through the Router must succeed for a legible scale screenshot")
			require.Zero(t, fallback.calls,
				"the fallback was reached — IdentifyBodyComposition has no fallback path by design (router.go), so this indicates the primary errored, not a budget miss")

			assertBodyCompReading(t, fx, reading)

			// The mobile client's own upload deadline, mirrored from
			// recipes.TestParseText_ThroughRouter_Smoke.
			require.Less(t, elapsed, 20*time.Second,
				"fixture %s: read took %s — too close to the client's own deadline", fx.label, elapsed)
		})
	}
}

// countingBodyCompFallback is an ai.Provider whose IdentifyBodyComposition
// counts calls and refuses to answer. Used as the Router's fallback leg so
// this test can assert the primary served every request — router.go's
// IdentifyBodyComposition has no fallback path at all, so any non-zero
// count here means the primary itself failed, not that a budget was missed.
type countingBodyCompFallback struct{ calls int }

func (p *countingBodyCompFallback) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) IdentifyBodyComposition(context.Context, []byte, string) (ai.BodyCompositionReading, ai.Usage, error) {
	p.calls++
	return ai.BodyCompositionReading{}, ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return "", ai.Usage{Provider: "counting"}, errBodyCompSmokeFallback
}

func (p *countingBodyCompFallback) Name() string { return "counting" }

var errBodyCompSmokeFallback = errBodyCompSmokeFallbackType{}

type errBodyCompSmokeFallbackType struct{}

func (errBodyCompSmokeFallbackType) Error() string {
	return "fallback must not be reached: IdentifyBodyComposition has no fallback path by design"
}

// bodyCompFieldPresent looks up name (an ai.BodyCompositionReading JSON
// tag, e.g. "muscle_mass_kg") on reading and reports whether that field is
// non-nil. The bool return distinguishes "field is nil" from "name isn't a
// real field at all" — a typo'd sidecar name (e.g. "muscel_mass_kg") must
// fail loudly as an unknown field, not silently assert nothing.
func bodyCompFieldPresent(reading ai.BodyCompositionReading, name string) (present, ok bool) {
	switch name {
	case "weight_kg":
		return reading.WeightKg != nil, true
	case "body_fat_pct":
		return reading.BodyFatPct != nil, true
	case "subcutaneous_fat_pct":
		return reading.SubcutaneousFatPct != nil, true
	case "visceral_fat_rating":
		return reading.VisceralFatRating != nil, true
	case "skeletal_muscle_pct":
		return reading.SkeletalMusclePct != nil, true
	case "muscle_mass_kg":
		return reading.MuscleMassKg != nil, true
	case "body_water_pct":
		return reading.BodyWaterPct != nil, true
	case "protein_pct":
		return reading.ProteinPct != nil, true
	case "bone_mass_kg":
		return reading.BoneMassKg != nil, true
	case "scale_bmr_kcal":
		return reading.ScaleBMRKcal != nil, true
	case "reading_date_text":
		// Checks the RAW model output, not the resolved ReadingDate —
		// "absent" here means the model reported no date text at all, which
		// is the actual fabrication kora#314 guards against at this layer.
		// A provider never populates ReadingDate directly any more (see
		// bodyCompositionResponseSchema), so checking it here would always
		// trivially pass regardless of what the model actually said.
		return reading.ReadingDateText != nil, true
	default:
		return false, false
	}
}

func derefFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
