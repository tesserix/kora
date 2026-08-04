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
}

// Mirrors ai.OutcomeOK / OutcomeError / OutcomeTimeout. Duplicated as literals
// rather than imported so this package stays free of any dependency on ai.
var knownOutcomes = map[string]bool{"ok": true, "error": true, "timeout": true}

// The sources the mobile app can send, plus "memory" which the server itself
// writes in foodlog.Service.CreateBatch.
var knownSources = map[string]bool{
	"ai_photo": true, "ai_text": true, "ai_voice": true, "ai_barcode": true,
	"manual": true, "memory": true, "meal": true,
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
