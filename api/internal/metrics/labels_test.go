package metrics

import "testing"

func TestNormalizeCallTypeKeepsKnownValues(t *testing.T) {
	for _, ct := range []string{"identify_photo", "identify_text", "transcribe", "coach", "decompose", "embed"} {
		if got := normalizeCallType(ct); got != ct {
			t.Errorf("normalizeCallType(%q) = %q, want %q", ct, got, ct)
		}
	}
}

func TestNormalizeCallTypeBucketsUnknownValues(t *testing.T) {
	if got := normalizeCallType("identify_hologram"); got != "other" {
		t.Errorf("normalizeCallType(unknown) = %q, want \"other\"", got)
	}
	if got := normalizeCallType(""); got != "other" {
		t.Errorf("normalizeCallType(empty) = %q, want \"other\"", got)
	}
}

func TestClassForSplitsResolutionFromDerived(t *testing.T) {
	resolution := []string{"identify_photo", "identify_text", "transcribe", "coach"}
	derived := []string{"decompose", "embed"}
	for _, ct := range resolution {
		if got := classFor(ct); got != "resolution" {
			t.Errorf("classFor(%q) = %q, want \"resolution\"", ct, got)
		}
	}
	for _, ct := range derived {
		if got := classFor(ct); got != "derived" {
			t.Errorf("classFor(%q) = %q, want \"derived\"", ct, got)
		}
	}
	if got := classFor("identify_hologram"); got != "other" {
		t.Errorf("classFor(unknown) = %q, want \"other\"", got)
	}
}

func TestNormalizeOutcome(t *testing.T) {
	for _, oc := range []string{"ok", "error", "timeout"} {
		if got := normalizeOutcome(oc); got != oc {
			t.Errorf("normalizeOutcome(%q) = %q, want %q", oc, got, oc)
		}
	}
	if got := normalizeOutcome("cancelled"); got != "other" {
		t.Errorf("normalizeOutcome(unknown) = %q, want \"other\"", got)
	}
}

// normalizeSource is the one that protects the billing surface: food_logs.source
// arrives verbatim from the client and is not validated by the API.
func TestNormalizeSource(t *testing.T) {
	for _, s := range []string{"ai_photo", "ai_text", "ai_voice", "ai_barcode", "manual", "memory", "meal"} {
		if got := normalizeSource(s); got != s {
			t.Errorf("normalizeSource(%q) = %q, want %q", s, got, s)
		}
	}
	if got := normalizeSource("'; DROP TABLE food_logs; --"); got != "other" {
		t.Errorf("normalizeSource(hostile) = %q, want \"other\"", got)
	}
}
