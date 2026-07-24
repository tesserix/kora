# Phase 3b — Mobile AI Capture Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dark full-screen Otto capture composer (`app/capture.tsx`) with four input modes (Photo · Voice · Scan · Type) that resolve a meal via the Phase 2c/3a resolve API and log it in one tap — matching `design-system/ui_kits/kora/CaptureScreen.jsx`.

**Architecture:** A full-screen dark modal route. Each mode captures input (native module) and calls a resolve mutation hook → the backend returns a `Resolution` (row-sourced nutrition + tier) → a `DetectedCard` renders it → "Add to diary" logs every candidate via the existing `useCreateLog`. All AI/nutrition is server-side; the screen is a pure presenter. The app migrates from managed-only to a **dev build** (native modules for camera/mic/photo).

**Tech Stack:** Expo SDK 57 (READ `https://docs.expo.dev/versions/v57.0.0/` before using any module), `expo-image-picker`, `expo-camera`, `expo-audio`, React 19, expo-router, TanStack React Query v5, TypeScript strict, Jest + RNTL v14 (async `render`).

## Global Constraints

- **Hard invariant (client side):** the screen NEVER computes or edits a nutrition number. Every kcal/macro comes from the backend `Resolution` and is displayed verbatim. Logging sends only `food_item_id` + `quantity_grams` + `meal_slot` + `source`; the backend recomputes nutrition from the row.
- **Fidelity:** match `CaptureScreen.jsx` (dark surface, Otto thread, composer pills, stages, DetectedCard). **No `oklch`** anywhere — React Native cannot parse it; translate the mockup's oklch colors to hex/hsl (use `hue.ts` for food-tile colors, and the capture-dark constants defined in Task 3). Gated by a UI-fidelity review vs the mockup before completion (see the `ui-fidelity-gate` memory).
- **TypeScript:** strict; no `any` (use `unknown` + narrow); props typed with named interfaces; no `React.FC`; no `console.log` (use the app's logger if needed). Immutable updates.
- **Errors:** no silent failures. Permission denial, empty/failed resolve, over-budget, network error → each an explicit Otto state. Narrow `unknown` errors via the existing `ApiError`.
- **Tests:** Jest + RNTL v14 — `await render(...)`; native modules mocked in `jest.setup.js` (follow the existing safe-area mock pattern). `npx tsc --noEmit` clean. Conventional single-line commits, no signature.
- **Auth:** all resolve calls use the existing `apiFetch` (Firebase token). Multipart (photo/voice) must NOT force `Content-Type: application/json`.

## Existing code (grounding — read before Task 1)

- `apps/mobile/app/` — `_layout.tsx` (root Stack; `<Stack.Screen name="meal" options={{ presentation: "transparentModal", animation: "fade" }} />` is the modal pattern), `(tabs)/`, `log.tsx` (manual search+log — the "Search manually" fallback), `meal.tsx`.
- `apps/mobile/src/api/` — `types.ts` (`Candidate = { item: FoodItem; match_score; match_tier }`, `FoodItem`, `FoodLog`), `hooks.ts` (`useFoodSearch`, `useCreateLog({food_item_id, meal_slot, source, quantity_grams, logged_at, client_log_ms?})`, React Query mutation pattern with `qc.invalidateQueries`).
- `apps/mobile/src/lib/` — `api.ts` (`apiFetch(path, init)` — forces `Content-Type: application/json`, attaches Firebase token, unwraps `{data}`, throws `ApiError{status, code, message}`), `foodVisual.ts` (`foodVisual(name, mealSlot?) => {hue, icon}`), `hue.ts` (`tileBg/tileFg/tileFaint/dot` hsl converters + `MACRO`), `firebase.ts`.
- `apps/mobile/src/components/` — `Icon.tsx` (kebab→lucide wrapper, Circle fallback), `Text.tsx` (AppText), `Button.tsx`, `Card.tsx`, `FoodTile.tsx`, `ProvenanceChip.tsx`, `ScreenHeader.tsx`, `CircularProgress.tsx`, `Sheet.tsx`, `FloatingTabBar.tsx` (center capture button → `router.push("/log")` at line ~57).
- `apps/mobile/src/theme/` — `tokens.ts` (light + dark palettes; dark has `background:#10101e`, `primary:#9c92ff`, `card:#19182a`, `mutedForeground:#ababc7`, `border:#302e50`, `success:#35c26d`), `index.ts` (theme hook), `theme.fonts.mono`, `shadows`.
- `apps/mobile/jest.setup.js` — native-module mocks (safe-area-context). `jest.config`/`package.json` — `moduleNameMapper` (lucide→CJS), `setupFiles`.
- `apps/mobile/app.json` — `expo.plugins: ["expo-router", ["expo-splash-screen", {...}]]`, no dev-client yet.
- Reference mockup: `design-system/ui_kits/kora/CaptureScreen.jsx` — the visual source of truth for layout/stages/composer/DetectedCard.

## Backend contract (from Phase 2c/3a)

- `POST /v1/resolve/text` — JSON `{phrase}` → `Resolution`.
- `POST /v1/resolve/photo` — multipart `file` (image) → `Resolution`.
- `POST /v1/resolve/voice` — multipart `file` (audio) → `Resolution`.
- `POST /v1/resolve/barcode` — JSON `{barcode}` (8–14 digits) → `Resolution`.
- `Resolution = { candidates: ResolvedCandidate[]; tier: "auto"|"confirm"|"follow_up"; follow_up_question?: string; is_estimate: boolean; kcal_low?: number; kcal_high?: number; provenance: string }`.
- `ResolvedCandidate = { item: FoodItem; portion_grams: number; kcal: number; match_score: number; match_tier: string }`.
- Log: `POST /v1/logs` via `useCreateLog`.

## File Structure

- Modify: `apps/mobile/app.json`, `apps/mobile/package.json` (deps), `apps/mobile/jest.setup.js` (native mocks).
- Modify: `apps/mobile/src/api/types.ts` (+`Resolution`, `ResolvedCandidate`), `apps/mobile/src/api/hooks.ts` (+resolve hooks), `apps/mobile/src/lib/api.ts` (multipart), `apps/mobile/src/lib/mealSlot.ts` (new).
- Create: `apps/mobile/src/components/capture/` — `OttoBubble.tsx`, `UserBubble.tsx`, `ModePill.tsx`, `Waveform.tsx`, `DetectedCard.tsx`, `captureTheme.ts` (dark constants).
- Create: `apps/mobile/app/capture.tsx`.
- Modify: `apps/mobile/app/_layout.tsx` (register modal), `apps/mobile/src/components/FloatingTabBar.tsx` (reroute).
- Tests colocated per the app's convention (`__tests__/` or `*.test.tsx`).

---

## Task 1: Dev-build migration — native modules + config + jest mocks

**Files:**
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/jest.setup.js`

**Interfaces:**
- Produces: `expo-image-picker`, `expo-camera`, `expo-audio`, `expo-dev-client` installed; config plugins + permission strings in `app.json`; jest mocks so component tests can import screens that use these modules.

- [ ] **Step 1: Install modules (use expo install for SDK-correct versions)**

```bash
cd apps/mobile && npx expo install expo-image-picker expo-camera expo-audio expo-dev-client
```
> READ the v57 docs for each (`https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/`, `/camera/`, `/audio/`) — confirm the current API surface (hooks vs imperative, permission methods) before Tasks 5–6 use them. Note any API differences from this plan in your report.

- [ ] **Step 2: Config plugins + permission strings in `app.json`**

Add to `expo.plugins` (merge with the existing `expo-router` + `expo-splash-screen`):
```json
      ["expo-image-picker", { "photosPermission": "Kora uses your photos to identify meals you log." }],
      ["expo-camera", { "cameraPermission": "Kora uses the camera to photograph and scan the foods you log." }],
      ["expo-audio", { "microphonePermission": "Kora uses the microphone so you can describe meals by voice." }]
```
(Exact plugin keys per the v57 docs — adapt if they differ.) Confirm `app.json` stays valid JSON.

- [ ] **Step 3: Jest mocks for the native modules**

In `apps/mobile/jest.setup.js`, add mocks so screens importing these modules render in tests (mirror the existing safe-area mock style). Minimal shape:
```js
jest.mock("expo-image-picker", () => ({
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  MediaTypeOptions: { Images: "Images" },
}));

jest.mock("expo-camera", () => ({
  CameraView: "CameraView",
  useCameraPermissions: () => [{ granted: true }, jest.fn(async () => ({ granted: true }))],
}));

jest.mock("expo-audio", () => ({
  useAudioRecorder: () => ({ record: jest.fn(), stop: jest.fn(async () => {}), uri: null }),
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));
```
> These mock shapes MUST match the real v57 API you confirmed in Step 1 — adjust names accordingly. Tasks 5–6 refine them if a specific return shape is needed.

- [ ] **Step 4: Verify tsc + jest still green**

Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: clean + all existing tests pass (the mocks are inert until used).

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/app.json apps/mobile/jest.setup.js
git commit -m "chore(mobile): add capture native modules (image-picker/camera/audio) + jest mocks"
```
> **Controller (after this task):** run `cd apps/mobile && npx expo prebuild --clean` then `npx expo run:ios` once to confirm the dev build compiles and boots on the sim (Xcode required). Native `ios/`/`android/` dirs stay gitignored (CNG regenerates from config). This is the toolchain switch from `expo export`; flag any prebuild failure.

---

## Task 2: API layer — Resolution types, multipart fetch, resolve hooks, meal-slot util

**Files:**
- Modify: `apps/mobile/src/api/types.ts`, `apps/mobile/src/api/hooks.ts`, `apps/mobile/src/lib/api.ts`
- Create: `apps/mobile/src/lib/mealSlot.ts` + test; hook tests

**Interfaces:**
- Produces: `Resolution`/`ResolvedCandidate` types; `apiFetchMultipart(path, form)`; `useResolveText/Photo/Voice/Barcode` mutations; `mealSlotForHour(hour) => MealSlot`.

- [ ] **Step 1: Types (`types.ts`)**
```ts
export type ResolveTier = "auto" | "confirm" | "follow_up";

export interface ResolvedCandidate {
  item: FoodItem;
  portion_grams: number;
  kcal: number;
  match_score: number;
  match_tier: string;
}

export interface Resolution {
  candidates: ResolvedCandidate[];
  tier: ResolveTier;
  follow_up_question?: string;
  is_estimate: boolean;
  kcal_low?: number;
  kcal_high?: number;
  provenance: string;
}
```

- [ ] **Step 2: Multipart fetch (`api.ts`) — test-first**
Write a test asserting `apiFetchMultipart` sends `FormData` WITHOUT a JSON content-type and WITH the auth token. Then add to `api.ts`:
```ts
export async function apiFetchMultipart(path: string, form: FormData): Promise<unknown> {
  const user = auth?.currentUser;
  const token = user ? await user.getIdToken() : null;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    body: form,
    // No Content-Type — fetch sets multipart/form-data with the boundary.
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? body;
}
```

- [ ] **Step 3: Meal-slot util (`mealSlot.ts`) — test-first**
```ts
export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

// mealSlotForHour maps a local hour (0-23) to a default meal slot.
export function mealSlotForHour(hour: number): MealSlot {
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}
```
Table test: 8→breakfast, 13→lunch, 19→dinner, 22→snack, 0→breakfast, 23→snack.

- [ ] **Step 4: Resolve hooks (`hooks.ts`) — test-first (mocked `apiFetch`/`apiFetchMultipart`)**
```ts
export function useResolveText() {
  return useMutation({
    mutationFn: (phrase: string) =>
      apiFetch("/v1/resolve/text", { method: "POST", body: JSON.stringify({ phrase }) }) as Promise<Resolution>,
  });
}

export function useResolveBarcode() {
  return useMutation({
    mutationFn: (barcode: string) =>
      apiFetch("/v1/resolve/barcode", { method: "POST", body: JSON.stringify({ barcode }) }) as Promise<Resolution>,
  });
}

export function useResolvePhoto() {
  return useMutation({
    mutationFn: (file: { uri: string; name: string; type: string }) => {
      const form = new FormData();
      // React Native FormData file shape:
      form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      return apiFetchMultipart("/v1/resolve/photo", form) as Promise<Resolution>;
    },
  });
}

export function useResolveVoice() {
  return useMutation({
    mutationFn: (file: { uri: string; name: string; type: string }) => {
      const form = new FormData();
      form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      return apiFetchMultipart("/v1/resolve/voice", form) as Promise<Resolution>;
    },
  });
}
```
Hook tests (mock `@/lib/api`): each mutation calls the right path/shape; multipart hooks build `FormData` with the file part. Use `await renderHook` + a QueryClient wrapper (follow the existing `hooks.test` pattern).

- [ ] **Step 5: tsc + jest + commit**
Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
```bash
git add apps/mobile/src/api apps/mobile/src/lib/api.ts apps/mobile/src/lib/mealSlot.ts apps/mobile/src/lib/__tests__ apps/mobile/src/api/__tests__
git commit -m "feat(mobile): resolve API types, multipart fetch, resolve hooks, meal-slot util"
```

---

## Task 3: Dark capture primitives

**Files:**
- Create: `apps/mobile/src/components/capture/captureTheme.ts`, `OttoBubble.tsx`, `UserBubble.tsx`, `ModePill.tsx`, `Waveform.tsx`, `DetectedCard.tsx` + tests

**Interfaces:**
- Produces: dark-surface primitives matching `CaptureScreen.jsx`. `DetectedCard` takes `{ resolution: Resolution; mealSlot: MealSlot; onChangeMealSlot; onAdd; adding }`.

- [ ] **Step 1: `captureTheme.ts` — dark constants (no oklch)**
Translate the mockup's oklch surface to hex. Provide a small typed object:
```ts
// Dark capture surface — the composer is a deliberate dark contrast to Kora's
// light editorial screens. Values translated from CaptureScreen.jsx's oklch
// (React Native cannot parse oklch) to hex/rgba.
export const captureColors = {
  surface: "#12211d",        // oklch(0.19 0.03 165) ≈ deep teal-black
  onSurface: "#ffffff",
  onSurfaceMuted: "rgba(255,255,255,0.6)",
  bubbleBg: "rgba(255,255,255,0.08)",
  bubbleBorder: "rgba(255,255,255,0.12)",
  cardBg: "rgba(255,255,255,0.07)",
  cardBorder: "rgba(255,255,255,0.14)",
  pillBg: "rgba(255,255,255,0.10)",
  primary: "#9c92ff",
  primaryForeground: "#10101e",
  composerBg: "rgba(0,0,0,0.25)",
} as const;
```
(Tune the surface hex to best match the mockup during the fidelity review.)

- [ ] **Step 2: `OttoBubble` / `UserBubble`** — chat bubbles per the mockup (Otto: sparkles avatar + translucent bubble, top-left radius 6; User: primary bubble right-aligned, top-right radius 6). Props `{ children: ReactNode }`. Component test: renders children.

- [ ] **Step 3: `ModePill`** — `{ icon: string; label: string; active: boolean; onPress: () => void }`; active = primary bg, else translucent. Uses `Icon`. Test: active styling + onPress.

- [ ] **Step 4: `Waveform`** — animated bars for the voice listening state (the mockup's 9 bars). Honor `prefers-reduced-motion` via `AccessibilityInfo.isReduceMotionEnabled` (static bars if reduced). Props `{ active: boolean }`. Test: renders bars.

- [ ] **Step 5: `DetectedCard` — the result card (test-first)**
Renders `resolution.candidates` as rows (icon via `foodVisual`, name, `${Math.round(portion_grams)}g · ${Math.round(match_score*100)}% match`, `Math.round(kcal)`), a header "Detected · N items", the total (`is_estimate ? "kcal_low–kcal_high" : sum(kcal)`), a meal-slot selector (4 chips), and "Add to diary" (calls `onAdd`, shows `adding` spinner) + optional "Edit" hint. All numbers rendered verbatim from the Resolution — no client math beyond summing the provided `kcal`.
Tests: renders N candidate rows with row-sourced kcal; estimate mode shows the range; meal-slot chip press calls `onChangeMealSlot`; "Add to diary" calls `onAdd`.

- [ ] **Step 6: tsc + jest + commit**
Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
```bash
git add apps/mobile/src/components/capture
git commit -m "feat(mobile): dark capture primitives (Otto bubbles, mode pill, waveform, detected card)"
```

---

## Task 4: Capture screen shell + navigation

**Files:**
- Create: `apps/mobile/app/capture.tsx`
- Modify: `apps/mobile/app/_layout.tsx`, `apps/mobile/src/components/FloatingTabBar.tsx` + tests

**Interfaces:**
- Produces: `app/capture.tsx` — dark full-screen modal with top bar, Otto thread, composer (4 `ModePill`s + text input), and stage state `idle | analyzing | result` (no live capture yet — Tasks 5–6 wire modes). Reroutes the tab capture button.

- [ ] **Step 1: The screen shell (test-first for structure/stages)**
Build `capture.tsx` per `CaptureScreen.jsx`: `captureColors.surface` full-screen, top bar (X → `router.back()`, "Ask Otto" sparkles, gallery icon), a scrollable Otto thread (greeting `OttoBubble`), the composer (4 `ModePill`s: Photo/Voice/Scan/Type + a text input + send button). Local state: `mode` (`photo|voice|scan|type`), `stage` (`idle|analyzing|result`), `resolution: Resolution | null`, `errorMsg: string | null`. Idle affordance per mode matches the mockup (viewfinder / mic+Waveform / barcode frame / text bubble). `useSafeAreaInsets` for the top inset (per the Phase 1c pattern). No `console.log`.
Test (`capture.test.tsx`, RNTL v14 async render): renders the greeting + 4 pills; tapping a pill switches `mode` (assert the idle affordance changes); the analyzing stage shows the spinner; result stage renders `DetectedCard` when `resolution` is set (inject via a test seam or by simulating a resolved mutation — keep the mode-capture calls stubbed here, fully wired in Tasks 5–6).

- [ ] **Step 2: Register the modal (`_layout.tsx`)**
```tsx
<Stack.Screen name="capture" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
```

- [ ] **Step 3: Reroute the tab capture button (`FloatingTabBar.tsx`)**
Change `router.push("/log")` → `router.push("/capture")`. Update/confirm the FloatingTabBar test.

- [ ] **Step 4: tsc + jest + commit**
Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/_layout.tsx apps/mobile/src/components/FloatingTabBar.tsx apps/mobile/app/__tests__ apps/mobile/src/components/__tests__
git commit -m "feat(mobile): capture screen shell + modal route + tab rerouting"
```

---

## Task 5: Mode wiring — Type + Photo

**Files:**
- Modify: `apps/mobile/app/capture.tsx` + test

**Interfaces:**
- Consumes: `useResolveText`, `useResolvePhoto`, `expo-image-picker`.
- Produces: Type + Photo modes fully wired capture→resolve→`stage="result"`.

- [ ] **Step 1: Type mode (test-first)** — the composer text input + send button → `useResolveText.mutate(phrase)`; on `onSuccess` set `resolution` + `stage="result"`; on error set `errorMsg` + an Otto error bubble. Analyzing stage while pending. Test: typing + send calls the mutation; success renders DetectedCard; error renders the error bubble (mock the hook).

- [ ] **Step 2: Photo mode (test-first)** — the viewfinder / camera button → `ImagePicker.launchCameraAsync` (fallback `launchImageLibraryAsync`; on sim there's no camera) after a permission check; on a non-canceled asset, build `{uri, name, type}` and `useResolvePhoto.mutate(file)`. Permission-denied → an Otto "I need camera access" bubble (no silent fail). Test (mocked `expo-image-picker`): a returned asset triggers `useResolvePhoto`; canceled → no call; denied permission → error bubble.

- [ ] **Step 3: tsc + jest + commit**
Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__
git commit -m "feat(mobile): wire capture Type + Photo modes to resolve"
```

---

## Task 6: Mode wiring — Voice + Scan

**Files:**
- Modify: `apps/mobile/app/capture.tsx` + test

**Interfaces:**
- Consumes: `useResolveVoice`, `useResolveBarcode`, `expo-audio`, `expo-camera`.
- Produces: Voice + Barcode modes wired.

- [ ] **Step 1: Voice mode (test-first)** — mic button starts `expo-audio` recording (show `Waveform active` + "Listening…"); stop → the recording `uri` → `{uri, name:"clip.m4a", type:"audio/mp4"}` → `useResolveVoice.mutate(file)`. Mic-permission denied → Otto error bubble. Test (mocked `expo-audio`): start→stop yields a uri → calls `useResolveVoice`; denied → error bubble.

- [ ] **Step 2: Scan mode (test-first)** — a `CameraView` (expo-camera) with barcode settings (EAN13/UPC-A/EAN8) in the idle affordance; `onBarcodeScanned` → `useResolveBarcode.mutate(data)` (guard against duplicate rapid scans). Camera-permission denied → Otto error bubble. **On the iOS sim there is no camera** — the CameraView renders but won't scan; the wiring + a simulated `onBarcodeScanned` callback are unit-tested; live scanning is device-only (flag in the report). Test (mocked `expo-camera`): a simulated scan callback calls `useResolveBarcode`; denied → error bubble.

- [ ] **Step 3: tsc + jest + commit**
Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__
git commit -m "feat(mobile): wire capture Voice + Scan modes to resolve"
```

---

## Task 7: Result → tier handling → add-to-diary

**Files:**
- Modify: `apps/mobile/app/capture.tsx` + test

**Interfaces:**
- Consumes: `useCreateLog`, `mealSlotForHour`, `DetectedCard`.
- Produces: full result handling — tiers, add-all logging, follow-up + manual fallback, error states.

- [ ] **Step 1: Tier rendering (test-first)**
- `auto`/`confirm` → `DetectedCard` (with an Otto summary bubble: "I found N items, about X kcal").
- `follow_up` → Otto renders `resolution.follow_up_question` + a "Search manually" button → `router.push("/log")`.
- `is_estimate` → `DetectedCard` shows the `kcal_low–kcal_high` range (already handled in DetectedCard).
- empty candidates + no question → a generic Otto "I couldn't identify that — try again or search manually" + manual link.
Tests: each tier renders the right UI; follow_up "Search manually" navigates to `/log` (mock `router`).

- [ ] **Step 2: Add-to-diary (test-first)**
Meal slot defaults to `mealSlotForHour(new Date().getHours())`, overridable via the DetectedCard selector. "Add to diary" → for each `candidate`, `createLog.mutate({ food_item_id: candidate.item.id, quantity_grams: candidate.portion_grams, meal_slot, source: "ai_"+mode, logged_at: new Date().toISOString() })`; await all; on success `router.back()` (RQ invalidation refreshes Home/Diary). Any failure → Otto error bubble, no partial silent success (report which items logged). 
Test: "Add to diary" with 3 candidates calls `createLog` 3× with the right `food_item_id`/`grams`/`meal_slot`/`source`; then navigates back. Error from one create → error state surfaced.

- [ ] **Step 3: tsc + jest + full suite + commit**
Run FOREGROUND: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__
git commit -m "feat(mobile): capture result tiers + add-all-to-diary logging"
```

- [ ] **Step 4: Fidelity review (controller, idb sim)**
Build the dev client (`npx expo run:ios`), sign in (demo), open capture from the tab bar. Verify vs `CaptureScreen.jsx`: dark surface, Otto thread, composer pills, idle affordances, analyzing, DetectedCard, add-to-diary → Home refresh. **Text** end-to-end, **Photo** via library, **Voice** via Mac mic are verifiable; **barcode live scan is device-only** (screenshot the scan UI, flag the live path). Fix runtime defects unit tests can't catch (safe-area, contrast, layout) before merge.

---

## Self-Review (spec Part B coverage)

- B1 dev-build migration (modules + plugins + permissions + jest mocks) → Task 1. ✓
- B2 API layer (Resolution types, multipart fetch, resolve hooks, meal-slot) → Task 2. ✓
- B3 dark primitives (Otto bubbles, ModePill, Waveform, DetectedCard) → Task 3. ✓
- B3/B5 capture screen + modal + reroute → Task 4. ✓
- Mode wiring (Type/Photo/Voice/Scan) → Tasks 5–6. ✓
- B4 result → tiers → add-all logging (source=ai_*, meal-slot inferred, follow_up→/log, estimate range, error states) → Task 7. ✓
- B6 tests + idb fidelity gate (with the camera-on-sim caveat) → each task's tests + Task 7 Step 4. ✓
- Invariant (client never computes nutrition; logs only id+grams+slot+source) → Tasks 2/7. ✓

**Placeholder scan:** the mockup (`CaptureScreen.jsx`) is the layout source of truth for pixel details deliberately not re-transcribed here; every task has concrete code for hooks/util/primitives/tier-logic and explicit test assertions. **Type consistency:** `Resolution`/`ResolvedCandidate` (Task 2) used in Tasks 3/7; `MealSlot`/`mealSlotForHour` (Task 2) in Tasks 3/7; `useResolve*`/`apiFetchMultipart` (Task 2) in Tasks 5/6; `DetectedCard` props (Task 3) consumed in Task 7.

## Prerequisites / follow-ups

- Phase 3a (`/v1/resolve/voice`) + Phase 2c (text/photo/barcode) endpoints must be reachable from the app (`EXPO_PUBLIC_API_URL`).
- READ the Expo SDK 57 docs for image-picker/camera/audio before Tasks 5–6 — adapt the mock shapes + API calls to the real surface.
- Barcode live scanning verified on a real device (out of sim scope).
- The v57 dev-build (`expo run:ios`) replaces the `expo export` flow used in Phase 1c for local sim testing; document it in the report.
