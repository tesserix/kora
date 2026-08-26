package platformauth

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// vector is one entry of testdata/vectors.json, which is byte-identical to
// mark8ly's and to the federation client's copy. RequestTarget is the raw
// wire form and is NOT what gets signed — Path is. It is carried here so the
// distinction stays visible in the fixture rather than only in prose.
type vector struct {
	Name          string `json:"name"`
	Secret        string `json:"secret"`
	Method        string `json:"method"`
	RequestTarget string `json:"request_target"`
	Path          string `json:"path"`
	RawQuery      string `json:"raw_query"`
	Body          string `json:"body"`
	Timestamp     string `json:"timestamp"`
	Nonce         string `json:"nonce"`
	Operator      string `json:"operator"`
	Capability    string `json:"capability"`
	Canonical     string `json:"canonical"`
	Signature     string `json:"signature"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	require.NoError(t, err)
	var vs []vector
	require.NoError(t, json.Unmarshal(raw, &vs))
	require.NotEmpty(t, vs, "vectors.json is the only thing keeping three implementations in agreement")
	return vs
}

func (v vector) input() SignatureInput {
	return SignatureInput{
		Method:     v.Method,
		Path:       v.Path,
		RawQuery:   v.RawQuery,
		Body:       []byte(v.Body),
		Timestamp:  v.Timestamp,
		Nonce:      v.Nonce,
		Operator:   v.Operator,
		Capability: v.Capability,
	}
}

// TestCanonicalStringMatchesThePublishedVectors is the test that matters. If
// it fails, Kora and the console disagree about what is being signed, and the
// only production symptom is an opaque 401 on every federated call.
func TestCanonicalStringMatchesThePublishedVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			got, err := CanonicalString(v.input())
			require.NoError(t, err)
			assert.Equal(t, v.Canonical, got)
		})
	}
}

func TestSignMatchesThePublishedVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			got, err := Sign(v.Secret, v.input())
			require.NoError(t, err)
			assert.Equal(t, v.Signature, got)
		})
	}
}

func TestVerifyAcceptsThePublishedVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			ok, err := Verify(v.Secret, v.Signature, v.input())
			require.NoError(t, err)
			assert.True(t, ok)
		})
	}
}

// TestVerifyAcceptsUppercaseHex covers the client stacks that emit uppercase
// by default. A naive string comparison would reject these with no
// explanation anywhere.
func TestVerifyAcceptsUppercaseHex(t *testing.T) {
	for _, v := range loadVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			ok, err := Verify(v.Secret, strings.ToUpper(v.Signature), v.input())
			require.NoError(t, err)
			assert.True(t, ok)
		})
	}
}

// TestVerifyRejectsATamperedField walks every signed field and confirms
// changing it alone breaks verification. Without this, a field could be
// dropped from CanonicalString and every vector would still pass, because
// the vectors only ever exercise one value per field.
func TestVerifyRejectsATamperedField(t *testing.T) {
	base := loadVectors(t)[0]

	mutations := map[string]func(*SignatureInput){
		"method":     func(in *SignatureInput) { in.Method = "POST" },
		"path":       func(in *SignatureInput) { in.Path += "/x" },
		"query":      func(in *SignatureInput) { in.RawQuery += "&extra=1" },
		"body":       func(in *SignatureInput) { in.Body = []byte("{}") },
		"timestamp":  func(in *SignatureInput) { in.Timestamp = "1755859201" },
		"nonce":      func(in *SignatureInput) { in.Nonce = "018f3c2a-0000-7000-8000-00000000ffff" },
		"operator":   func(in *SignatureInput) { in.Operator = "op_other" },
		"capability": func(in *SignatureInput) { in.Capability = "audit.write" },
	}

	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			in := base.input()
			mutate(&in)
			ok, err := Verify(base.Secret, base.Signature, in)
			require.NoError(t, err)
			assert.False(t, ok, "%s is not covered by the signature", name)
		})
	}
}

func TestVerifyRejectsAWrongSecret(t *testing.T) {
	v := loadVectors(t)[0]
	ok, err := Verify(v.Secret+"x", v.Signature, v.input())
	require.NoError(t, err)
	assert.False(t, ok)
}

// TestVerifyTreatsAMalformedSignatureAsAMismatch — non-hex on the wire is
// indistinguishable from a client with the wrong key, so it must not become
// an error the caller could tell apart from a plain rejection.
func TestVerifyTreatsAMalformedSignatureAsAMismatch(t *testing.T) {
	v := loadVectors(t)[0]
	ok, err := Verify(v.Secret, "not-hex-at-all", v.input())
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestSignAndVerifyRejectAnEmptySecret(t *testing.T) {
	v := loadVectors(t)[0]

	_, err := Sign("", v.input())
	require.Error(t, err)

	_, err = Verify("", v.Signature, v.input())
	require.Error(t, err, "an unconfigured secret must be loud, not a valid-looking HMAC over nothing")
}

// TestCanonicalQueryEscapesSpacesAsPlus pins the one divergence from
// encodeURIComponent that silently 401s a TypeScript implementation.
func TestCanonicalQueryEscapesSpacesAsPlus(t *testing.T) {
	got, err := CanonicalQuery("actor=Jane%20Smith")
	require.NoError(t, err)
	assert.Equal(t, "actor=Jane+Smith", got)

	got, err = CanonicalQuery("q=a%2Bb")
	require.NoError(t, err)
	assert.Equal(t, "q=a%2Bb", got, "a literal + must survive as %2B, not become a space")
}

// TestCanonicalQuerySortsRepeatedValues — map iteration order must not reach
// the wire. A single run can pass by luck, so assert the sorted result
// directly rather than comparing two runs.
func TestCanonicalQuerySortsRepeatedValues(t *testing.T) {
	got, err := CanonicalQuery("b=2&a=z&a=a")
	require.NoError(t, err)
	assert.Equal(t, "a=a&a=z&b=2", got)
}

func TestCanonicalStringRejectsLineBreaks(t *testing.T) {
	// Operator="a", Capability="b\nc" and Operator="a\nb", Capability="c"
	// would otherwise join to identical bytes.
	in := loadVectors(t)[0].input()
	in.Capability = "b\nc"
	_, err := CanonicalString(in)
	require.Error(t, err)

	in = loadVectors(t)[0].input()
	in.Path = "/admin/x\rY"
	_, err = CanonicalString(in)
	require.Error(t, err)
}
