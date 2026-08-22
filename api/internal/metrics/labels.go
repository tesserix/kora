package metrics

// Known AI call types. Anything outside this set is recorded as labelOther, so
// a typo, a new call type, or a hostile value can never create unbounded label
// cardinality.
const (
	callIdentifyPhoto = "identify_photo"
	callIdentifyText  = "identify_text"
	callTranscribe    = "transcribe"
	callCoach         = "coach"
	callDecompose     = "decompose"
	callEmbed         = "embed"
	// Recipe ingestion (POST /v1/recipes/parse). Mirrors
	// recipes.callTypeParseText / callTypeParsePhoto — a value that is not
	// listed here disappears into labelOther, which would leave recipe parsing
	// as invisible in the metrics as it was before it was metered at all.
	callParseRecipeText  = "parse_recipe_text"
	callParseRecipePhoto = "parse_recipe_photo"
	// Body-composition screenshot reads (POST /v1/body-composition/read).
	// A value not listed here disappears into labelOther — see the #81
	// lesson noted on the recipe call types just above.
	callIdentifyBodyComposition = "identify_body_composition"
)

// labelOther is the sink for any value outside a known set. A non-zero count on
// it is itself a signal: either a new legitimate value shipped without updating
// these tables, or something is sending junk. This deliberately trades a
// silently wrong label for a visible one — the cost being that a mistyped
// call_type disappears into a bucket rather than announcing itself.
const labelOther = "other"

// COGS classes, settled in issue #43. `resolution` is the headline number and is
// comparable between users; `derived` scales with meal complexity (decompose)
// and corrections (embed), so folding it into a per-log ratio would make that
// ratio uninterpretable. Total COGS is the sum of both.
const (
	classResolution = "resolution"
	classDerived    = "derived"
)

var classByCallType = map[string]string{
	callIdentifyPhoto: classResolution,
	callIdentifyText:  classResolution,
	callTranscribe:    classResolution,
	callCoach:         classResolution,
	callDecompose:     classDerived,
	callEmbed:         classDerived,
	// A recipe parse is one user-initiated ingestion of one recipe — the same
	// shape as an identify, so it belongs to the headline resolution class
	// rather than to `derived`, which scales with meal complexity.
	callParseRecipeText:  classResolution,
	callParseRecipePhoto: classResolution,
	// A body-composition read is one user-initiated capture of one
	// screenshot — the same shape as an identify, so it belongs to the
	// headline resolution class too.
	callIdentifyBodyComposition: classResolution,
}

// Mirrors ai.OutcomeOK / OutcomeError / OutcomeTimeout. Duplicated as literals
// rather than imported so this package stays free of any dependency on ai.
var knownOutcomes = map[string]bool{"ok": true, "error": true, "timeout": true}

// The sources the mobile app can send, plus the ones the server itself writes
// through foodlog.Service.CreateBatch: "memory" (its default) and "recipe"
// (recipes.LogRecipe's fan-out). This map is the authoritative source list —
// foodlog.batchSources and the food_logs.source CHECK constraint both mirror
// it, and apps/mobile/src/api/types.ts points at it.
var knownSources = map[string]bool{
	"ai_photo": true, "ai_text": true, "ai_voice": true, "ai_barcode": true,
	"manual": true, "memory": true, "meal": true, "recipe": true,
}

func normalizeCallType(callType string) string {
	if _, ok := classByCallType[callType]; ok {
		return callType
	}
	return labelOther
}

// classFor derives the class from the call type, so the two labels can never
// disagree with each other.
func classFor(callType string) string {
	if class, ok := classByCallType[callType]; ok {
		return class
	}
	return labelOther
}

func normalizeOutcome(outcome string) string {
	if knownOutcomes[outcome] {
		return outcome
	}
	return labelOther
}

func normalizeSource(source string) string {
	if knownSources[source] {
		return source
	}
	return labelOther
}
