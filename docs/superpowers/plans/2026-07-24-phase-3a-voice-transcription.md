# Phase 3a — Backend Voice Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the one missing backend capability for Phase 3 — audio→text transcription — so a recorded voice clip resolves through the existing engine: a `Transcribe` method on `ai.Provider` (Gemini-only), `Resolver.ResolveVoice`, and `POST /v1/resolve/voice`.

**Architecture:** Voice reuses the entire Phase 2c resolve pipeline. The only new AI step is Gemini transcription; the transcript is fed straight into the existing `ResolveText` flow, so tiers, metering, the hard invariant, and caching all carry over unchanged. Transcription stays on Gemini (the OpenAI/NVIDIA fallback returns an error, exactly like `Embed`, so the router never sends audio to a text-only model).

**Tech Stack:** Go 1.26; `google.golang.org/genai` (Gemini multimodal audio); Gin; testify. Reuses `ai.Resolver`, `nutrition.Repository`, `billing.Meter`, the `resolve` handler.

## Global Constraints

- **Hard invariant (unchanged):** every nutrition number comes from a `nutrition.FoodItem` row. Transcription returns plain text only; the transcript is treated as a search phrase — it never carries a nutrition number, and the schema-bounded identify/decompose steps downstream are unchanged.
- **Transcription is Gemini-only.** OpenAI/NVIDIA `Transcribe` returns a clear error (mirrors `Embed`); the router falls back → that error → clean end-to-end failure, never audio to a text model.
- **Voice reuses `ResolveText`.** After transcription, `ResolveVoice` delegates to the existing `ResolveText(transcript)` — do NOT duplicate the identify/resolve/decompose logic.
- **Uploads bounded before parse:** the voice handler wraps the body in `http.MaxBytesReader` before `c.FormFile` (same pattern as `ResolvePhoto`), with a 12 MB cap (audio clips run larger than photos).
- **Metering:** the transcription call records `Usage{CallType: "transcribe"}`; cost uses the existing `EstimateCostUSD` table (`gemini-3.5-flash` already priced). The downstream identify/embed rows are recorded by `ResolveText` as today.
- **Errors** wrapped `fmt.Errorf("<pkg>: <op>: %w", err)`; never swallow; no panics outside main.
- **Tests:** `cd api && go test -race -p 1 ./...` run FOREGROUND. No live LLM in normal `go test` — live audio only under `//go:build smoke`. DB tests skip without Postgres. `gofmt`/`vet` clean. Conventional single-line commits, no signature.
- **Local:** `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable'`. Keys in `api/.env` (`GEMINI_API_KEY` verified).

## Existing code (grounding — read before Task 1)

- `internal/ai/provider.go` — `Provider` interface: `IdentifyText`, `IdentifyPhoto`, `Decompose`, `Embed`, `Name`. Implementers: `providers.GeminiProvider`, `providers.OpenAIProvider`, `ai.Router`, and the test `stubProvider`.
- `internal/ai/provider_test.go` — shared `stubProvider` with per-call result/usage/err fields, `block bool`, `delay time.Duration`, `calls int`.
- `internal/ai/providers/gemini.go` — `GeminiProvider`, `modelFlash = "gemini-3.5-flash"`, `callType*` consts, `generateJSON` helper, `genai.NewPartFromBytes(data, mime)`, `genai.NewContentFromParts(parts, genai.RoleUser)`, `SystemInstruction: &genai.Content{Parts: ...}`. `var _ ai.Provider = GeminiProvider{}`.
- `internal/ai/providers/openai.go` — `OpenAIProvider`; `Embed` returns a "not supported" error. `var _ ai.Provider = OpenAIProvider{}`.
- `internal/ai/router.go` — `Router`, `withFallback[T](ctx, budget, fbBudget, primary, fallback)`, `photoBudgetOrDefault()`, `fallbackBudgetOrDefault()`. `var _ Provider = (*Router)(nil)`.
- `internal/ai/resolver.go` — `Resolver{provider, foods, cache, meter}`, `ResolveText(ctx, userID, phrase)`, `ResolvePhoto(...)`, private `resolve(...)` (cache→budget→identify→resolveGuesses→decompose), `record(...)`, `CacheKey(kind, value)`, `budgetFollowUpQuestion`.
- `internal/resolve/handler.go` — `Handler{tp TextPhotoResolver, bc BarcodeResolver}`, `TextPhotoResolver` (`ResolveText`/`ResolvePhoto`), `NewHandler`, `ResolvePhoto` (multipart + `MaxBytesReader` + `maxPhotoBytes`/`maxPhotoBodyBytes`), `user.IDFromContext`, `httpx`.
- `internal/resolve/handler_test.go` — `stubTP` implementing `TextPhotoResolver`; `newEngine`/`newEngineNoUser` helpers set/omit `user_id`.
- `internal/server/router.go` — resolve routes registered under `if deps.Resolver != nil`.
- `cmd/api/main.go` — `resolve.NewHandler(resolver, barcodeFn)`; `resolver` is `ai.NewResolver(...)` (value). **No change needed** if `TextPhotoResolver` is extended and `ai.Resolver` implements the new method (`ai.Resolver` already satisfies the port).

## File Structure

- Modify: `internal/ai/provider.go` (+`Transcribe`), `internal/ai/provider_test.go` (stub).
- Modify: `internal/ai/providers/gemini.go` (+`Transcribe` impl, `transcribeSystemPrompt`, `callTypeTranscribe`), `gemini_test.go`.
- Modify: `internal/ai/providers/openai.go` (+`Transcribe` error), `openai_test.go`.
- Modify: `internal/ai/router.go` (+`Transcribe`), `router_test.go`.
- Modify: `internal/ai/resolver.go` (+`ResolveVoice`), `resolver_test.go`.
- Modify: `internal/resolve/handler.go` (+`ResolveVoice` + extend `TextPhotoResolver`), `handler_test.go`.
- Modify: `internal/server/router.go` (+`/resolve/voice` route), `router_test.go`.
- Create: `internal/ai/providers/transcribe_smoke_test.go` (`//go:build smoke`).

---

## Task 1: `Provider.Transcribe` — interface, Gemini impl, OpenAI error, Router, stub

**Files:**
- Modify: `internal/ai/provider.go`, `internal/ai/provider_test.go`
- Modify: `internal/ai/providers/gemini.go`, `internal/ai/providers/gemini_test.go`
- Modify: `internal/ai/providers/openai.go`, `internal/ai/providers/openai_test.go`
- Modify: `internal/ai/router.go`, `internal/ai/router_test.go`
- Create: `internal/ai/providers/transcribe_smoke_test.go`

**Interfaces:**
- Produces: `Provider.Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error)`. Gemini transcribes via `modelFlash`; OpenAI errors; Router routes via `withFallback` (photo budget). Stub gains a `transcript`/`transcriptUsage`/`transcriptErr` triple + method.

- [ ] **Step 1: Extend the interface (compile-break first)**

In `internal/ai/provider.go`, add to `Provider`:
```go
	// Transcribe converts spoken audio (a person describing what they ate)
	// into plain text. Only the primary (Gemini) implements it; the fallback
	// returns an error, so audio is never sent to a text-only model.
	Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error)
```
Run `cd api && go build ./...` → FAIL (implementers missing `Transcribe`). This confirms every implementer is caught by the compiler.

- [ ] **Step 2: Stub `Transcribe` (test fixture) + failing router test**

In `internal/ai/provider_test.go`, add fields to `stubProvider`:
```go
	transcript      string
	transcriptUsage Usage
	transcriptErr   error
```
and the method (honoring `block`/`delay` like the others):
```go
func (s *stubProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error) {
	s.calls++
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return "", Usage{}, ctx.Err()
		}
	}
	if s.block {
		<-ctx.Done()
		return "", Usage{}, ctx.Err()
	}
	return s.transcript, s.transcriptUsage, s.transcriptErr
}
```
In `internal/ai/router_test.go`, add a test that primary errors → fallback serves the transcript, mirroring the existing `TestRouter_PrimaryErrors_FallsBackToFallback_*`:
```go
func TestRouter_Transcribe_PrimaryErrors_FallsBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", transcriptErr: errors.New("boom")}
	fallback := &stubProvider{name: "fallback-stub", transcript: "chicken and rice", transcriptUsage: Usage{Provider: "fallback-stub"}}
	r := &Router{Primary: primary, Fallback: fallback}
	got, usage, err := r.Transcribe(context.Background(), []byte("audio"), "audio/mp4")
	require.NoError(t, err)
	assert.Equal(t, "chicken and rice", got)
	assert.Equal(t, "fallback-stub", usage.Provider)
}
```
Run `cd api && go test ./internal/ai/ -run TestRouter_Transcribe` → FAIL (Router has no `Transcribe`).

- [ ] **Step 3: Router `Transcribe`**

In `internal/ai/router.go`, add (audio is a vision-class call → photo budget):
```go
func (r *Router) Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error) {
	return withFallback(ctx, r.photoBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) (string, Usage, error) { return r.Primary.Transcribe(c, audio, mime) },
		func(c context.Context) (string, Usage, error) { return r.Fallback.Transcribe(c, audio, mime) },
	)
}
```
Run the router test → PASS.

- [ ] **Step 4: OpenAI `Transcribe` (error) + test**

In `internal/ai/providers/openai.go`:
```go
// Transcribe is intentionally NOT implemented for the OpenAI-compatible
// fallback: NVIDIA's llama models are text-only, and transcription stays on
// Gemini (multimodal). Returning an error keeps the router from ever sending
// audio to a model that cannot process it.
func (p OpenAIProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	return "", ai.Usage{}, fmt.Errorf("openai: transcribe: not supported — transcription stays on Gemini (multimodal audio)")
}
```
In `internal/ai/providers/openai_test.go`, add:
```go
func TestOpenAITranscribeNotSupported(t *testing.T) {
	p := NewOpenAIProvider("k", "", "", false)
	_, _, err := p.Transcribe(context.Background(), []byte("x"), "audio/mp4")
	if err == nil {
		t.Fatal("expected Transcribe to return an error on the fallback provider")
	}
}
```

- [ ] **Step 5: Gemini `Transcribe` impl + parse test**

In `internal/ai/providers/gemini.go`, add the call-type const (alongside the others) and prompt:
```go
	callTypeTranscribe = "transcribe"
```
```go
	transcribeSystemPrompt = "You transcribe short audio clips of a person " +
		"describing what they ate. Return ONLY the spoken words as plain text — " +
		"no commentary, no punctuation cleanup beyond what's spoken, and never " +
		"any calorie or nutrition number. If the audio contains no discernible " +
		"speech, return an empty string."
```
Add the method (plain-text output — no `ResponseSchema`, unlike `generateJSON`):
```go
// Transcribe converts spoken audio to text using the multimodal Flash model.
// The transcript is later treated as a search phrase, so this returns plain
// text with no schema — the identity/nutrition invariants are enforced
// downstream by the identify/decompose schemas, not here.
func (p GeminiProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	start := time.Now()
	cfg := &genai.GenerateContentConfig{
		SystemInstruction: &genai.Content{Parts: []*genai.Part{genai.NewPartFromText(transcribeSystemPrompt)}},
	}
	resp, err := p.client.Models.GenerateContent(ctx, modelFlash,
		[]*genai.Content{genai.NewContentFromParts([]*genai.Part{genai.NewPartFromBytes(audio, mime)}, genai.RoleUser)}, cfg)
	usage := ai.Usage{Provider: p.Name(), Model: modelFlash, CallType: callTypeTranscribe, LatencyMs: int(time.Since(start).Milliseconds())}
	if resp != nil && resp.UsageMetadata != nil {
		usage.TokensIn = int(resp.UsageMetadata.PromptTokenCount)
		usage.TokensOut = int(resp.UsageMetadata.CandidatesTokenCount)
	}
	if err != nil {
		return "", usage, fmt.Errorf("gemini: transcribe: %w", err)
	}
	return strings.TrimSpace(resp.Text()), usage, nil
}
```
Add `"strings"` to gemini.go imports if not present. In `gemini_test.go`, add a no-network test asserting the compile-time `var _ ai.Provider = GeminiProvider{}` still holds and that the call-type const is wired (a light test — the real transcription is smoke-only). Example:
```go
func TestTranscribeCallTypeConst(t *testing.T) {
	if callTypeTranscribe != "transcribe" {
		t.Fatalf("callTypeTranscribe = %q", callTypeTranscribe)
	}
}
```
> Verify `resp.Text()` and `UsageMetadata` field names against the installed genai version (`go doc google.golang.org/genai`), matching how `generateJSON` reads them.

- [ ] **Step 6: build, vet, foreground test, commit**

Run: `cd api && gofmt -l . && go vet ./internal/ai/... && go build ./... && go test -race -p 1 ./internal/ai/...`
Expected: clean + PASS. Create the smoke test `internal/ai/providers/transcribe_smoke_test.go`:
```go
//go:build smoke

package providers

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestGeminiTranscribeSmoke needs GEMINI_API_KEY and a KORA_SMOKE_AUDIO path
// (a short spoken-food clip, e.g. audio/mp4). Run:
//   set -a && . ./.env && set +a
//   KORA_SMOKE_AUDIO=/path/clip.m4a go test -tags smoke ./internal/ai/providers/ -run TestGeminiTranscribeSmoke -v
func TestGeminiTranscribeSmoke(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	path := os.Getenv("KORA_SMOKE_AUDIO")
	if key == "" || path == "" {
		t.Skip("GEMINI_API_KEY/KORA_SMOKE_AUDIO not set — skipping transcribe smoke")
	}
	audio, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read audio: %v", err)
	}
	p, err := NewGeminiProvider(context.Background(), key)
	if err != nil {
		t.Fatalf("gemini: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	text, usage, err := p.Transcribe(ctx, audio, "audio/mp4")
	if err != nil {
		t.Fatalf("Transcribe: %v", err)
	}
	if text == "" {
		t.Fatal("empty transcript")
	}
	t.Logf("transcript=%q usage=%+v", text, usage)
}
```
Verify it compiles: `cd api && go vet -tags smoke ./internal/ai/providers/`.
```bash
git add api/internal/ai/provider.go api/internal/ai/provider_test.go api/internal/ai/router.go api/internal/ai/router_test.go api/internal/ai/providers
git commit -m "feat(api): add Transcribe to ai.Provider (gemini-only) with router fallback"
```

---

## Task 2: `Resolver.ResolveVoice`

**Files:**
- Modify: `internal/ai/resolver.go`, `internal/ai/resolver_test.go`

**Interfaces:**
- Consumes: `Provider.Transcribe`, existing `ResolveText`.
- Produces: `Resolver.ResolveVoice(ctx context.Context, userID uuid.UUID, audio []byte, mime string) (Resolution, error)`.

- [ ] **Step 1: Failing test**

In `internal/ai/resolver_test.go`, add (using the existing stub provider + seeded/foods pattern the resolver tests already use):
```go
func TestResolveVoiceTranscribesThenResolves(t *testing.T) {
	// stub transcribes to a phrase that the stubbed foods repo resolves to a row.
	prov := &stubProvider{transcript: "banana"} // identify/embed use the same stub
	// ... build Resolver with the same foods stub/seed the resolver tests use ...
	res, err := r.ResolveVoice(context.Background(), uuid.New(), []byte("audio-bytes"), "audio/mp4")
	require.NoError(t, err)
	require.NotEmpty(t, res.Candidates)
	// kcal is row-sourced (same invariant assertion style as the existing guard test)
}

func TestResolveVoiceBlankTranscriptFollowUp(t *testing.T) {
	prov := &stubProvider{transcript: "   "}
	// ... build Resolver ...
	res, err := r.ResolveVoice(context.Background(), uuid.New(), []byte("audio"), "audio/mp4")
	require.NoError(t, err)
	assert.Equal(t, TierFollowUp, res.Tier)
	assert.Empty(t, res.Candidates)
}
```
> Match the exact Resolver/stub construction used by the existing resolver tests (read `resolver_test.go` first — reuse its stub provider fields, fake `foods`, `NoCache{}`, and meter). The stub's `IdentifyText` must return a `Guess{Food: "banana", Confidence: 0.95}` (or similar) so the transcript resolves; set the stub's `guesses` accordingly.

Run `cd api && go test ./internal/ai/ -run TestResolveVoice` → FAIL (`ResolveVoice` undefined).

- [ ] **Step 2: Implement `ResolveVoice`**

In `internal/ai/resolver.go`, add (imports: `crypto/sha256`, `encoding/hex`, `strings` are already used by the file for `ResolvePhoto`/CacheKey — confirm):
```go
// blankTranscriptFollowUp is returned when transcription yields no usable
// speech — the user recorded silence or noise.
const blankTranscriptFollowUp = "I couldn't make out any food from that — try again or type it."

// ResolveVoice transcribes an audio clip and resolves the transcript through
// the same pipeline as ResolveText. Transcription is metered separately; the
// transcript is just a search phrase, so the hard invariant and tiers are
// unchanged. Cached by audio content hash so identical clips don't re-transcribe.
func (r Resolver) ResolveVoice(ctx context.Context, userID uuid.UUID, audio []byte, mime string) (Resolution, error) {
	sum := sha256.Sum256(audio)
	key := CacheKey("voice", hex.EncodeToString(sum[:]))
	if cached, ok := r.cache.Get(ctx, key); ok {
		return *cached, nil
	}

	ok, err := r.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: check budget: %w", err)
	}
	if !ok {
		return Resolution{Tier: TierFollowUp, FollowUpQuestion: budgetFollowUpQuestion, Provenance: "budget"}, nil
	}

	transcript, usage, err := r.provider.Transcribe(ctx, audio, mime)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: transcribe: %w", err)
	}
	r.record(ctx, userID, usage)

	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		return Resolution{Tier: TierFollowUp, FollowUpQuestion: blankTranscriptFollowUp, Provenance: "voice"}, nil
	}

	// Reuse the full text pipeline (identify → resolve → tiers → decompose).
	res, err := r.ResolveText(ctx, userID, transcript)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: %w", err)
	}
	r.cache.Set(ctx, key, res)
	return res, nil
}
```
Run `cd api && go test -race -p 1 ./internal/ai/ -run TestResolveVoice` → PASS.

- [ ] **Step 3: full ai test + commit**

Run: `cd api && gofmt -l . && go vet ./internal/ai/ && go test -race -p 1 ./internal/ai/`
```bash
git add api/internal/ai/resolver.go api/internal/ai/resolver_test.go
git commit -m "feat(api): Resolver.ResolveVoice — transcribe then resolve as text"
```

---

## Task 3: `POST /v1/resolve/voice` handler + route

**Files:**
- Modify: `internal/resolve/handler.go`, `internal/resolve/handler_test.go`
- Modify: `internal/server/router.go`, `internal/server/router_test.go`

**Interfaces:**
- Produces: `resolve.Handler.ResolveVoice(c)`; `TextPhotoResolver` gains `ResolveVoice(ctx, userID, audio, mime) (ai.Resolution, error)`. Route `POST /v1/resolve/voice`.

- [ ] **Step 1: Extend the port + failing handler tests**

In `internal/resolve/handler.go`, add to `TextPhotoResolver`:
```go
	ResolveVoice(ctx context.Context, userID uuid.UUID, audio []byte, mime string) (ai.Resolution, error)
```
Add a cap const near `maxPhotoBytes`:
```go
// maxAudioBytes caps an uploaded voice clip. Audio runs larger than photos.
const maxAudioBytes = 12 << 20 // 12 MiB
const maxAudioBodyBytes = maxAudioBytes + 1<<10
```
In `internal/resolve/handler_test.go`, extend `stubTP` with:
```go
func (s *stubTP) ResolveVoice(ctx context.Context, uid uuid.UUID, audio []byte, mime string) (ai.Resolution, error) {
	s.gotMime = mime
	return s.voice, s.err
}
```
(add a `voice ai.Resolution` field to `stubTP`). Add tests mirroring the photo tests: `TestResolveVoice_Success` (multipart `file` audio → 200, envelope carries tier), `TestResolveVoice_NoFile` (→400), `TestResolveVoice_BodyExceedsHardCap` (>12 MiB body → 413), `TestResolveVoice_Unauthorized` (→401). Reuse the multipart-body + `newEngine`/`newEngineNoUser` helpers already in the file.

Run `cd api && go test ./internal/resolve/` → FAIL (`ResolveVoice` undefined on Handler + `stubTP`).

- [ ] **Step 2: Implement the handler**

In `internal/resolve/handler.go`, add (mirror `ResolvePhoto` exactly, swapping the caps and the resolver call):
```go
func (h Handler) ResolveVoice(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAudioBodyBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "audio exceeds 12MB limit")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "file is required")
		return
	}
	if fileHeader.Size > maxAudioBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "audio exceeds 12MB limit")
		return
	}
	f, err := fileHeader.Open()
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	defer f.Close()
	buf, err := io.ReadAll(f)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	mime := fileHeader.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(buf)
	}
	res, err := h.tp.ResolveVoice(c.Request.Context(), uid, buf, mime)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, res)
}
```
Run `cd api && go test -race -p 1 ./internal/resolve/` → PASS.

- [ ] **Step 3: Register the route (test first)**

In `internal/server/router_test.go`, extend the existing resolve-route registration test to also assert `POST /v1/resolve/voice` is present when `Resolver != nil` (and absent when nil). Run → FAIL.

In `internal/server/router.go`, inside the `if deps.Resolver != nil {` block:
```go
			v1.POST("/resolve/voice", deps.Resolver.ResolveVoice)
```
Run `cd api && go test -race -p 1 ./internal/resolve/ ./internal/server/` → PASS.

- [ ] **Step 4: whole-build + commit**

Run: `cd api && gofmt -l . && go vet ./... && go build ./... && go test -race -p 1 ./internal/ai/... ./internal/resolve/ ./internal/server/`
Expected: clean + PASS. (`cmd/api/main.go` needs no change — `ai.Resolver` now satisfies the extended `TextPhotoResolver`.)
```bash
git add api/internal/resolve/handler.go api/internal/resolve/handler_test.go api/internal/server/router.go api/internal/server/router_test.go
git commit -m "feat(api): mount POST /v1/resolve/voice (transcribe + resolve)"
```

---

## Self-Review (spec Part A coverage)

- A1 Provider `Transcribe` (Gemini impl / OpenAI error / Router / stub) → Task 1. ✓
- A2 `Resolver.ResolveVoice` (transcribe → ResolveText, blank/over-budget follow-ups, audio-hash cache) → Task 2. ✓
- A3 `POST /v1/resolve/voice` (multipart, MaxBytesReader before parse, caps, 401/400/413) + route → Task 3. ✓
- A4 tests (Transcribe map, OpenAI error, ResolveVoice unit, voice handler, `//go:build smoke` live) → Tasks 1–3. ✓
- Invariant unchanged (transcript is a phrase; downstream schemas enforce identity-only) → structural; ResolveVoice delegates to ResolveText. ✓
- Metering `call_type: "transcribe"`, priced via existing `gemini-3.5-flash` rate → Task 1/2. ✓

**Placeholder scan:** none — resolver_test construction is flagged "match the existing stub/foods pattern (read the file first)" rather than inventing helpers. **Type consistency:** `Transcribe(ctx, audio []byte, mime string) (string, Usage, error)` identical across interface/Gemini/OpenAI/Router/stub; `ResolveVoice(ctx, userID uuid.UUID, audio []byte, mime string) (Resolution, error)` identical across Resolver + the `resolve` port + `stubTP`.

## Follow-ups

- Controller: record a short spoken-food clip and run the `//go:build smoke` transcription test live to confirm Gemini audio quality + latency before Phase 3b ships the voice mode.
- Phase 3b (mobile) consumes `POST /v1/resolve/voice` (multipart audio) via `useResolveVoice`.
