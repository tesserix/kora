# Kora Phase 3 — Mobile AI Capture (Otto composer → resolve → log)

**Status:** Approved (brainstorming complete, 2026-07-24).
**Parent design:** `docs/superpowers/specs/2026-07-24-kora-build-design.md`.
**Builds on:** Phase 2c resolve API (`POST /v1/resolve/{text,photo,barcode}`, the `ai` engine, `foodlog` log-edit). Reference mockup: `design-system/ui_kits/kora/CaptureScreen.jsx`.

## Goal

Wire the mobile app's capture flow into the AI resolution engine: a full-screen **Otto capture composer** with four input modes (Photo · Voice · Scan · Type) that resolve a meal to row-sourced nutrition and log it in one tap. Adds the one missing backend piece (voice transcription); the text/photo/barcode endpoints already exist.

## Decisions (locked in brainstorming)

- **Modes:** all four — Photo, Text, Barcode (Scan), Voice.
- **Voice:** backend Gemini transcription (no on-device STT, no paid service). All AI stays server-side and free, consistent with the engine's architecture.
- **Result → log:** streamlined **add-all**. One meal-slot selector (auto-inferred from local time); "Add to diary" logs every detected candidate at once; per-item grams edits happen afterward via the diary's existing `PATCH /v1/logs/:id`.
- **Entry point:** the floating tab bar's center capture button routes to the new `app/capture.tsx` (was `/log`). `/log` remains the "Search manually" fallback.
- **Surface:** dark full-screen modal matching the mockup, translated to RN theme constants — **no `oklch`** anywhere (React Native can't parse it; use rgb/hsl per the `hue.ts` convention and the Phase 1c fidelity rule).

## Non-goals (YAGNI)

- No on-device/offline STT; no streaming/partial transcription (record → send → transcript).
- No live camera *preview* filters or ML on-device; identification is server-side.
- No new nutrition math on the client — every kcal/macro comes from the backend `Resolution` (row-sourced). The client never computes or edits a nutrition number.
- No redesign of the diary/home/log screens; capture only adds a screen + reroutes the capture button.

## Global constraints

- **Hard invariant (unchanged):** every nutrition number originates from a `nutrition.FoodItem` row via the backend. The client displays `Resolution` values verbatim and never derives kcal/macros.
- **Free stack:** Gemini (free) for transcription + identification; NVIDIA free fallback for identify/decompose only. Transcription is **Gemini-only** (fallback errors, like `Embed`).
- **Auth:** all `/v1/*` calls carry the Firebase ID token (existing `apiFetch`). Multipart uploads (photo, voice) must NOT force `Content-Type: application/json`.
- **Errors:** no silent failures. Every failure mode (permission denied, empty/failed resolve, over-budget, network) has an explicit Otto state. Backend errors wrapped per package convention; infra→500 generic, validation→400.
- **Mobile:** Expo SDK 57 — consult `https://docs.expo.dev/versions/v57.0.0/` before using any native module. Managed CNG project migrates to a **dev build** (native modules). TypeScript strict; no `any`; props typed; no `console.log`. Tests via Jest + RNTL v14 (async `render`).
- **Go:** `go test -race -p 1`; DB/live tests skip without their deps; `gofmt`/`vet` clean. Conventional single-line commits, no signature.

---

## Part A (Phase 3a) — Backend: voice transcription

Small, self-contained, unblocks the mobile build. Reuses the entire resolve pipeline; the only new AI capability is audio→text.

### A1. Provider `Transcribe`
- Extend `ai.Provider` with `Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error)`.
- **Gemini** (`providers/gemini.go`): implement via `GenerateContent` on `modelFlash` with an audio `Part` (`genai.NewPartFromBytes(audio, mime)`) + a system instruction: *"Transcribe this audio of a person describing what they ate. Return only the spoken words as plain text — no commentary, no nutrition numbers."* Return the text + `Usage{CallType: "transcribe"}`.
- **OpenAI/NVIDIA** (`providers/openai.go`): return a clear "not supported — transcription stays on Gemini" error (mirrors `Embed`), so the router never falls back audio to a text-only model.
- **Router** (`router.go`): add `Transcribe` using `withFallback` — Gemini primary, fallback returns its error → clean end-to-end failure if Gemini is down (no corruption path). Use the photo latency budget (audio is a vision-class call).
- Stub `Provider`s in tests gain a `Transcribe` field. `parseTranscript` is trivial (the response text is the transcript) — unit-test the Gemini request-building/response-mapping via the existing pattern; live audio exercised only by a `//go:build smoke` test.

### A2. `Resolver.ResolveVoice`
- `ResolveVoice(ctx, userID uuid.UUID, audio []byte, mime string) (Resolution, error)`:
  1. cache key = `CacheKey("voice", sha256(audio))`; cache Get first.
  2. `WithinBudget` check (same graceful over-budget Resolution).
  3. `provider.Transcribe(audio, mime)` → record usage.
  4. If the transcript is blank → a follow-up Resolution ("I couldn't make out any food — try again or type it").
  5. Otherwise feed the transcript through the **existing** `resolveGuesses`/decompose path — i.e. call the same internal flow `ResolveText` uses (identify → embed → `nutrition.Resolve` → tiers → decompose). Cache + return.
- The transcript reuses `ResolveText`'s identify step (the transcript is just the phrase), so tiers/metering/invariant are unchanged.

### A3. `POST /v1/resolve/voice`
- `resolve.Handler.ResolveVoice`: `http.MaxBytesReader` before parse (audio cap, e.g. 12 MB — audio clips run larger than photos), `file` multipart part, mime from the part (fallback `http.DetectContentType`), 413 on oversize, 400 on missing file, 401 without user. Calls `tp.ResolveVoice(...)`.
- Add `ResolveVoice` to the `resolve` handler's resolver port (extend `TextPhotoResolver` → a `VoiceResolver` method, or a combined port). Register `v1.POST("/resolve/voice", deps.Resolver.ResolveVoice)`.
- Metering row `call_type: "transcribe"` (+ the downstream identify/embed rows).

### A4. Backend tests
- `Transcribe` request-shape + response-map unit tests (no network); OpenAI `Transcribe` returns error (tested).
- `ResolveVoice` unit: stub provider returns a canned transcript → asserts it resolves to a row-sourced candidate; blank transcript → follow-up; over-budget → graceful.
- Voice handler tests: 200 (stub), 400 no file, 413 oversize, 401 no user.
- `//go:build smoke` live Gemini-audio transcription test (skips without key + a fixture clip).

---

## Part B (Phase 3b) — Mobile: capture composer

### B1. Native build migration
- Add Expo SDK 57 modules (via `npx expo install`): `expo-image-picker`, `expo-camera`, `expo-audio`. Add config plugins + iOS/Android permission strings (camera, microphone, photo library) in `app.json`. This converts the project to a **dev build** (`expo-dev-client`); document the run command change (`npx expo run:ios` / EAS dev build) vs the old `expo export` flow.
- **Read the v57 docs for each module before use** (per `apps/mobile/AGENTS.md`).

### B2. API layer
- `Resolution` + `ResolvedCandidate` types in `src/api/types.ts` mirroring the Go shapes (`candidates[]`, `tier`, `follow_up_question?`, `is_estimate`, `kcal_low?`, `kcal_high?`, `provenance`).
- `apiFetch` multipart support: a variant/param that omits the default `Content-Type` so `FormData` sets its own boundary (still attaches the auth token).
- Hooks (React Query mutations): `useResolveText`, `useResolvePhoto`, `useResolveVoice`, `useResolveBarcode`. `useResolvePhoto/Voice` build `FormData` with the captured file.
- Reuse `useCreateLog` for the add-all commit.

### B3. Capture screen (`app/capture.tsx`) + components
- Dark full-screen modal registered in `app/_layout.tsx`. Structure per `CaptureScreen.jsx`: top bar (close→back, "Ask Otto", gallery), Otto thread, composer (4 mode pills + input row).
- Extract reusable pieces into `src/components/`: `OttoBubble`, `UserBubble`, `DetectedCard` (+ its row), a `Waveform` (voice), a `ModePill`. Keep each focused (<~150 lines).
- **Stages**: `idle` → `analyzing` (Otto "analyzing…" + spinner) → `result`. Per-mode idle affordance (viewfinder / mic+waveform / barcode frame / text bubble) matching the mockup.
- **Mode wiring**:
  - Type → text input → `useResolveText`.
  - Photo → `expo-image-picker` (camera on device, library on sim) → `useResolvePhoto`.
  - Voice → `expo-audio` record (start/stop, live waveform) → on stop `useResolveVoice`.
  - Scan → `expo-camera` `CameraView` barcode settings (EAN/UPC) → on scan `useResolveBarcode`.
- **DetectedCard** ← `Resolution.candidates`: icon via `foodVisual`, name, `${grams}g · ${match%}`, row-sourced kcal, total kcal; meal-slot selector; "Add to diary" (+ "Edit"→ inline note that grams are editable in the diary, or a light per-row grams field — keep minimal).

### B4. Result → tier handling → log
- `auto`/`confirm` → DetectedCard.
- `follow_up` → Otto renders `follow_up_question` + a "Search manually" button → `router.push("/log")`.
- `is_estimate` → DetectedCard shows the `kcal_low–kcal_high` range instead of a single total.
- over-budget/unknown → Otto renders the backend's graceful `follow_up_question`/message.
- **Add to diary**: `mealSlotForHour(localHour)` default (breakfast <11, lunch 11–16, dinner 16–21, else snack), overridable; for each candidate call `useCreateLog` (`food_item_id`, `quantity_grams = portion_grams`, `meal_slot`, `source = ai_${mode}`), then `router.back()` to Home; RQ invalidation refreshes the feed/rings.
- All failures surface an Otto error state (never a silent no-op).

### B5. Entry point
- Floating tab bar center button → `router.push("/capture")` (was `/log`). Verify the capture route registers and Home/Diary unaffected.

### B6. Mobile tests + fidelity
- Unit: `mealSlotForHour` table; hooks (mocked `fetch`/`apiFetch`) for each resolve mode + multipart shape; capture-screen component tests (stage transitions, pill switching, DetectedCard renders candidates, add-all calls `createLog` per item with correct source/slot, `follow_up` renders question + manual link, error state). RNTL v14 async `render`.
- **Fidelity gate (idb sim)**: verify against `CaptureScreen.jsx` — dark surface, thread, composer pills, all visual stages, DetectedCard. **Text** end-to-end, **Photo** via library, **Voice** via the Mac mic are sim-verifiable. **Barcode live scanning is device-only** (iOS sim has no camera): the scan UI + wiring are unit-tested and screenshotted, with the live path flagged for on-device verification.

---

## Architecture / data flow

```
Capture screen (dark modal)
  ├─ Type  → useResolveText   → POST /v1/resolve/text    (JSON)
  ├─ Photo → useResolvePhoto  → POST /v1/resolve/photo   (multipart)
  ├─ Voice → useResolveVoice  → POST /v1/resolve/voice   (multipart audio)
  │            └─ backend: Gemini Transcribe → transcript → ResolveText pipeline
  └─ Scan  → useResolveBarcode→ POST /v1/resolve/barcode (JSON)
                     ↓ Resolution { candidates[], tier, follow_up_question?, is_estimate, kcal_low/high, provenance }
        DetectedCard (row-sourced kcal) + meal-slot selector
                     ↓ Add to diary
        useCreateLog × N  → POST /v1/logs  → RQ invalidate → Home/Diary refresh
```

Every nutrition number is produced server-side from a `FoodItem` row; the client is a pure presenter of `Resolution`.

## Testing strategy (summary)

- **3a**: Go unit (Transcribe map, ResolveVoice flow, voice handler) + build-tagged live smoke. `-race -p 1`, skip-without-deps.
- **3b**: Jest/RNTL unit (util, hooks, capture screen states/flows) + idb sim fidelity review vs the mockup, with the documented camera-on-sim caveat.

## Rollout / risks

- **Dev-build migration** is the largest infra change — it alters the local run/test workflow (dev client vs `expo export`). Flagged; the plan sequences it first in 3b.
- **Sim can't exercise the camera** → barcode live path is device-only; everything else is sim-verifiable.
- **Gemini audio transcription quality/latency** is unvalidated until the live smoke — the eval/smoke will confirm before the mode ships; voice degrades gracefully (blank-transcript follow-up) if it's weak.
- Voice/photo/audio uploads are size-capped and bounded before parse (reuse the photo `MaxBytesReader` pattern) — no unbounded reads.

## Execution

Two plan/build cycles off this one spec:
- **Phase 3a** — backend voice transcription (Parts A1–A4). Small.
- **Phase 3b** — mobile capture composer (Parts B1–B6). Large; depends on 3a + Phase 2c endpoints.

Each: `superpowers:writing-plans` → `superpowers:subagent-driven-development`, with the mobile phase gated by the UI-fidelity review against `design-system/ui_kits/kora/CaptureScreen.jsx`.
