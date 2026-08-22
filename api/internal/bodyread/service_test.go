package bodyread

import (
	"context"
	"errors"
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

func TestReader_Read_ReadingDate(t *testing.T) {
	t.Run("present and valid parses through with no drop", func(t *testing.T) {
		provider := &stubProvider{reading: ai.BodyCompositionReading{ReadingDate: sptr("2020-01-01")}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		require.NotNil(t, result.Reading.ReadingDate)
		assert.Equal(t, "2020-01-01", *result.Reading.ReadingDate)
		assert.Empty(t, result.Dropped)
	})

	t.Run("absent is nil with no drop entry", func(t *testing.T) {
		provider := &stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(70)}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		assert.Nil(t, result.Reading.ReadingDate)
		assert.Empty(t, result.Dropped)
	})

	t.Run("future date is dropped with a drop entry", func(t *testing.T) {
		future := "2999-01-01"
		provider := &stubProvider{reading: ai.BodyCompositionReading{ReadingDate: sptr(future)}}
		r := NewReader(provider, newStubCache(), &stubMeter{})

		result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
		require.NoError(t, err)
		assert.Nil(t, result.Reading.ReadingDate)
		require.Len(t, result.Dropped, 1)
		assert.Equal(t, "reading_date", result.Dropped[0].Field)
	})
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

func TestReader_Read_ProviderErrorIsNotUnreadable(t *testing.T) {
	provider := &stubProvider{err: errors.New("upstream 503")}
	r := NewReader(provider, newStubCache(), &stubMeter{})

	result, err := r.Read(context.Background(), uuid.New(), []byte("img"), "image/jpeg")
	require.Error(t, err, "a provider error must propagate as a real Go error")
	assert.False(t, result.Unreadable, "the zero-value Result on an error path is not the 422 unreadable case")
}
