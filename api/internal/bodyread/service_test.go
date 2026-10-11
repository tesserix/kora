package bodyread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

// stubProvider implements ai.Provider. Only IdentifyBodyComposition is
// meaningful for this package; the rest exist to satisfy the interface,
// mirroring recipes' stubProvider.
type stubProvider struct {
	reading  ai.BodyCompositionReading
	usage    ai.Usage
	err      error
	calls    int
	gotImage []byte
	gotMime  string
}

func (s *stubProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) IdentifyBodyComposition(_ context.Context, image []byte, mime string) (ai.BodyCompositionReading, ai.Usage, error) {
	s.calls++
	s.gotImage = image
	s.gotMime = mime
	return s.reading, s.usage, s.err
}
func (s *stubProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}
func (s *stubProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}
func (s *stubProvider) Name() string { return "stub" }

// stubMeter implements ai.Meter — mirrors recipes' stubMeter.
type stubMeter struct {
	overBudget  bool
	budgetErr   error
	recorded    []ai.Usage
	budgetCalls int
}

func (m *stubMeter) WithinBudget(context.Context, uuid.UUID) (bool, error) {
	m.budgetCalls++
	if m.budgetErr != nil {
		return false, m.budgetErr
	}
	return !m.overBudget, nil
}

func (m *stubMeter) Record(_ context.Context, _ uuid.UUID, u ai.Usage, _ float64) error {
	m.recorded = append(m.recorded, u)
	return nil
}

// stubCache implements bodyread.Cache with an in-memory map, so cache-hit
// behavior (no provider call) is directly assertable.
type stubCache struct {
	entries map[string]Result
}

func newStubCache() *stubCache { return &stubCache{entries: map[string]Result{}} }

func (c *stubCache) Get(_ context.Context, key string) (*Result, bool) {
	r, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	return &r, true
}

func (c *stubCache) Set(_ context.Context, key string, r Result) {
	c.entries[key] = r
}

// DeleteByUser removes every entry whose key is prefixed
// "body_composition:<userID>:" — mirrors RedisCache's SCAN-by-prefix
// semantics closely enough to assert against in a test without a real
// Redis.
func (c *stubCache) DeleteByUser(_ context.Context, userID uuid.UUID) error {
	prefix := "body_composition:" + userID.String() + ":"
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			delete(c.entries, k)
		}
	}
	return nil
}

func TestReader_Read_AbsentFieldsStayNil(t *testing.T) {
	provider := &stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(72.4)}}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.NoError(t, err)
	require.NotNil(t, result.Reading.WeightKg)
	assert.Equal(t, 72.4, *result.Reading.WeightKg)
	assert.Nil(t, result.Reading.BodyFatPct)
	assert.Nil(t, result.Reading.MuscleMassKg)
	assert.Nil(t, result.Reading.ReadingDate)
	assert.False(t, result.Unreadable)
}

func TestReader_Read_VisceralFatRatingSurvivesValidation(t *testing.T) {
	for _, v := range []float64{7, 45} {
		provider := &stubProvider{reading: ai.BodyCompositionReading{VisceralFatRating: ptr(v)}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		require.NotNil(t, result.Reading.VisceralFatRating)
		assert.Equal(t, v, *result.Reading.VisceralFatRating)
		assert.Empty(t, result.Dropped)
	}
}

func TestReader_Read_ImplausibleValuesDroppedAndReported(t *testing.T) {
	provider := &stubProvider{reading: ai.BodyCompositionReading{
		WeightKg:   ptr(72.4),
		BodyFatPct: ptr(999), // implausible
	}}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.NoError(t, err)
	require.NotNil(t, result.Reading.WeightKg)
	assert.Nil(t, result.Reading.BodyFatPct)
	require.Len(t, result.Dropped, 1)
	assert.Equal(t, "body_fat_pct", result.Dropped[0].Field)
	assert.False(t, result.Unreadable, "a partial reading with some drops is NOT unreadable")
}

// TestReader_Read_ReadingDate pins the post-kora#314 date pipeline through
// the public Reader.Read entry point: the PROVIDER supplies only raw,
// verbatim ReadingDateText (never a resolved date — see
// ai.BodyCompositionReading's doc comment), and Read() is responsible for
// resolving it (date_resolve.go) and then validating the result
// (validate.go), in that order. Resolver-format edge cases (D/M
// disambiguation, leap years, "not yet occurred this year") are unit-tested
// directly against resolveReadingDateText in date_resolve_test.go with a
// fixed "now" — this suite only proves the WIRING, so every case here uses
// either an unambiguous explicit-year date (stable regardless of the real
// clock) or an inherently-ambiguous string (ambiguous regardless of the
// real clock too), so none of it is flaky against a real time.Now().
func TestReader_Read_ReadingDate(t *testing.T) {
	t.Run("reading_date_text resolves and parses through with no drop", func(t *testing.T) {
		provider := &stubProvider{reading: ai.BodyCompositionReading{ReadingDateText: sptr("2020-01-01")}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		require.NotNil(t, result.Reading.ReadingDate)
		assert.Equal(t, "2020-01-01", *result.Reading.ReadingDate)
		assert.Empty(t, result.Dropped)
	})

	t.Run("absent reading_date_text is nil with no drop entry", func(t *testing.T) {
		provider := &stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(70)}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		assert.Nil(t, result.Reading.ReadingDate)
		assert.Empty(t, result.Dropped)
	})

	t.Run("ambiguous reading_date_text resolves to nil with no drop entry", func(t *testing.T) {
		// "05/06" is ambiguous (D/M vs M/D) regardless of what day it is
		// run — see resolveReadingDateText's doc comment. Nil here is a
		// "never resolved" outcome, not a validation failure, so no
		// DroppedField is expected — same as any other field the model
		// simply never reported.
		provider := &stubProvider{reading: ai.BodyCompositionReading{ReadingDateText: sptr("05/06")}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		assert.Nil(t, result.Reading.ReadingDate)
		assert.Empty(t, result.Dropped)
	})

	t.Run("a resolved ReadingDate the provider sets directly is ignored", func(t *testing.T) {
		// Providers only ever populate ReadingDateText in practice (the
		// schema has no reading_date property any more — see
		// bodyCompositionResponseSchema), but this proves the CONTRACT
		// itself: Read() always recomputes ReadingDate from
		// ReadingDateText and never trusts whatever a provider happens to
		// leave in the resolved field, so a future/malformed value placed
		// there directly (a stub, a bug, a provider that regresses) can
		// never leak through untouched.
		future := "2999-01-01"
		provider := &stubProvider{reading: ai.BodyCompositionReading{ReadingDate: sptr(future)}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		assert.Nil(t, result.Reading.ReadingDate)
		assert.Empty(t, result.Dropped)
	})
}

// TestReader_Read_CacheKeyUsesDownscaledBytes proves the ordering documented
// in service.go's Read: the cache key must be built from the DOWNSCALED
// bytes actually sent to the provider, not the original upload. Every other
// test in this file feeds non-decodable byte slices through Read, which
// makes downscaleForProvider a no-op passthrough and so cannot distinguish
// "hash the downscaled bytes" from "hash the original bytes" — this test
// uses a real, deliberately oversized synthetic image (synthImage, defined
// in downscale_test.go) so downscaleForProvider actually resizes it.
func TestReader_Read_CacheKeyUsesDownscaledBytes(t *testing.T) {
	src := synthImage(2000, 1000) // long side well over maxDimension
	original := encodeJPEG(t, src)

	provider := &stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(72.4)}}
	cache := newStubCache()
	r := NewReader(provider, cache, &stubMeter{})

	uid := uuid.New()
	_, err := r.Read(context.Background(), uid, original, "image/jpeg")
	require.NoError(t, err)

	require.NotEmpty(t, provider.gotImage)
	assert.NotEqual(t, len(original), len(provider.gotImage),
		"the oversized fixture must actually have been downscaled before reaching the provider")

	sum := sha256.Sum256(provider.gotImage)
	wantKey := ai.CacheKey("body_composition", uid, hex.EncodeToString(sum[:]))
	_, ok := cache.entries[wantKey]
	assert.True(t, ok, "cache key must hash the DOWNSCALED bytes sent to the provider, not the original upload")
}

func TestReader_Read_CacheHitSkipsProvider(t *testing.T) {
	provider := &stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(72.4)}}
	cache := newStubCache()
	r := NewReader(provider, cache, &stubMeter{})

	uid := uuid.New()
	image := []byte("same-bytes")

	first, err := r.Read(context.Background(), uid, image, "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, 1, provider.calls)

	second, err := r.Read(context.Background(), uid, image, "image/jpeg")
	require.NoError(t, err)
	assert.Equal(t, 1, provider.calls, "byte-identical second call must hit the cache, not the provider")
	assert.Equal(t, first, second)
}

func TestReader_Read_OverBudgetNeverReachesProvider(t *testing.T) {
	provider := &stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(72.4)}}
	meter := &stubMeter{overBudget: true}
	r := NewReader(provider, newStubCache(), meter)

	_, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.ErrorIs(t, err, ErrBudgetExhausted)
	assert.Equal(t, 0, provider.calls, "an over-budget call must never reach the provider")
}

func TestReader_Read_EverythingNilIsUnreadable(t *testing.T) {
	provider := &stubProvider{reading: ai.BodyCompositionReading{}}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.NoError(t, err)
	assert.True(t, result.Unreadable)
}

func TestReader_Read_SomeFieldsLegibleIsNotUnreadable(t *testing.T) {
	// Some fields survive validation, others (implausible) get dropped —
	// rule #12: partial success is NOT unreadable.
	provider := &stubProvider{reading: ai.BodyCompositionReading{
		WeightKg:   ptr(72.4),
		BodyFatPct: ptr(-50), // implausible, will be dropped
	}}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.NoError(t, err)
	require.NotEmpty(t, result.Dropped)
	assert.False(t, result.Unreadable)
}

func TestReader_Read_InstrumentOnlyIsNotUnreadable(t *testing.T) {
	// A reading where instrument is the ONLY surviving field (every
	// measurement nil, no date) is still a partial success, not
	// unreadable — isEmpty must consult Instrument exactly like every
	// other field, or a confidently-detected instrument on an otherwise
	// blank read would be silently discarded as a 422.
	provider := &stubProvider{reading: ai.BodyCompositionReading{Instrument: sptr("dexa")}}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.NoError(t, err)
	assert.False(t, result.Unreadable)
	require.NotNil(t, result.Reading.Instrument)
	assert.Equal(t, "dexa", *result.Reading.Instrument)
}

func TestReader_Read_ProviderErrorIsNotUnreadable(t *testing.T) {
	provider := &stubProvider{err: errors.New("upstream 503")}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.Error(t, err, "a provider error must propagate as a real Go error")
	assert.False(t, result.Unreadable, "the zero-value Result on an error path is not the 422 unreadable case")
}
