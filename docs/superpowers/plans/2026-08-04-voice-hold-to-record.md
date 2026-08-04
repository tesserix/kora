# Voice Hold-to-Record + Mode-Aware Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the capture composer reflect the selected mode, and turn voice capture into hold-to-record with slide-to-cancel and swipe-to-lock.

**Architecture:** The recording state machine is a pure module with no React, no gesture-handler and no expo-audio, so it can be tested for real. A thin `VoiceComposer` component translates pan gestures into events for that reducer and renders the result. `app/capture.tsx`'s composer becomes mode-aware, and `IdleAffordance`'s voice branch becomes display-only. The UI kit mockup is updated to match, because it currently encodes the bug.

**Tech Stack:** React Native 0.86 / Expo SDK 57, TypeScript, `react-native-gesture-handler` (`Gesture.Pan`), `react-native-reanimated`, `expo-audio`, Jest + `@testing-library/react-native`.

## Global Constraints

- Working directory for all commands: `apps/mobile`.
- Tests: `npx jest --ci --forceExit`. Typecheck: `npx tsc --noEmit`. Both must pass at every commit. Baseline is **109 suites / 713 tests**; the count only goes up.
- Run tests in the **foreground**. Backgrounded runs stall in this environment.
- `npx expo lint` regenerates `apps/mobile/eslint.config.js` **and** adds `eslint` + `eslint-config-expo` to `devDependencies`. Never commit any of the three — check `git status` before staging.
- Commits: conventional prefix, **single line**, no body, no trailers, no signature.
- **Every new test must be mutation-verified**: break the behaviour the test names, confirm it fails on *that test's own assertion*, revert, confirm `git diff` is clean. A test that passes against broken code is worse than no test — see #82.
- Do **not** modify `useResolveVoice`, `buildFileForm`, or anything in `src/api/`.
- Thresholds are fixed by the spec: `PRESS_ARM_MS = 200`, `CANCEL_DX = -80`, `LOCK_DY = -60`.

---

### Task 1: Recording state machine (pure module)

**Files:**
- Create: `src/capture/voiceRecording.ts`
- Test: `src/capture/__tests__/voiceRecording.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VoiceState` (`"idle" | "armed" | "recording" | "locked" | "finished" | "cancelled"`), `VoiceEvent`, `PRESS_ARM_MS`, `CANCEL_DX`, `LOCK_DY`, `initialVoiceState`, `reduceVoice(state, event) => VoiceState`, and `shouldUpload(state) => boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import {
  CANCEL_DX,
  LOCK_DY,
  PRESS_ARM_MS,
  initialVoiceState,
  reduceVoice,
  shouldUpload,
} from "../voiceRecording";

test("a press that is held past the arm delay starts recording", () => {
  const armed = reduceVoice(initialVoiceState, { type: "press" });
  expect(armed).toBe("armed");
  expect(reduceVoice(armed, { type: "armDelayElapsed" })).toBe("recording");
});

// A stray tap must NOT bill a 0.2s clip to the transcription endpoint.
test("a press released before the arm delay never records", () => {
  const armed = reduceVoice(initialVoiceState, { type: "press" });
  const after = reduceVoice(armed, { type: "release" });
  expect(after).toBe("idle");
  expect(shouldUpload(after)).toBe(false);
});

test("sliding left past the cancel threshold discards the clip", () => {
  const rec = reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" });
  const cancelled = reduceVoice(rec, { type: "pan", dx: CANCEL_DX - 1, dy: 0 });
  expect(cancelled).toBe("cancelled");
  expect(shouldUpload(cancelled)).toBe(false);
});

test("a slide short of the cancel threshold keeps recording", () => {
  const rec = reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" });
  expect(reduceVoice(rec, { type: "pan", dx: CANCEL_DX + 1, dy: 0 })).toBe("recording");
});

test("swiping up past the lock threshold locks hands-free", () => {
  const rec = reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" });
  expect(reduceVoice(rec, { type: "pan", dx: 0, dy: LOCK_DY - 1 })).toBe("locked");
});

test("releasing while locked does nothing — only Stop ends a locked recording", () => {
  const locked = reduceVoice(
    reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" }),
    { type: "pan", dx: 0, dy: LOCK_DY - 1 },
  );
  expect(reduceVoice(locked, { type: "release" })).toBe("locked");
  expect(reduceVoice(locked, { type: "stop" })).toBe("finished");
});

test("releasing a held recording finishes it and uploads", () => {
  const rec = reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" });
  const finished = reduceVoice(rec, { type: "release" });
  expect(finished).toBe("finished");
  expect(shouldUpload(finished)).toBe(true);
});

test("cancelling from the locked state does not upload", () => {
  const locked = reduceVoice(
    reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" }),
    { type: "pan", dx: 0, dy: LOCK_DY - 1 },
  );
  const cancelled = reduceVoice(locked, { type: "cancel" });
  expect(cancelled).toBe("cancelled");
  expect(shouldUpload(cancelled)).toBe(false);
});

test("only the finished state ever uploads", () => {
  expect(shouldUpload("idle")).toBe(false);
  expect(shouldUpload("armed")).toBe(false);
  expect(shouldUpload("recording")).toBe(false);
  expect(shouldUpload("locked")).toBe(false);
  expect(shouldUpload("cancelled")).toBe(false);
  expect(shouldUpload("finished")).toBe(true);
});

test("thresholds match the spec", () => {
  expect(PRESS_ARM_MS).toBe(200);
  expect(CANCEL_DX).toBe(-80);
  expect(LOCK_DY).toBe(-60);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --ci --forceExit src/capture/__tests__/voiceRecording.test.ts`
Expected: FAIL — `Cannot find module '../voiceRecording'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Pure recording state machine for voice capture. Deliberately free of React,
// gesture-handler and expo-audio: the pan gesture cannot be meaningfully
// simulated under Jest (gesture-handler is mocked), so ALL the decision-making
// lives here where it can be tested for real, and the gesture wiring stays thin
// enough to review by eye.
export type VoiceState = "idle" | "armed" | "recording" | "locked" | "finished" | "cancelled";

export type VoiceEvent =
  | { type: "press" }
  | { type: "armDelayElapsed" }
  | { type: "pan"; dx: number; dy: number }
  | { type: "release" }
  | { type: "stop" }
  | { type: "cancel" };

// A press shorter than this is a mis-tap, not a recording. Without it a stray
// tap fires a fraction-of-a-second clip at a paid transcription endpoint.
export const PRESS_ARM_MS = 200;
// Horizontal slide (left, hence negative) that abandons the clip.
export const CANCEL_DX = -80;
// Vertical swipe (up, hence negative) that locks into hands-free recording.
export const LOCK_DY = -60;

export const initialVoiceState: VoiceState = "idle";

export function reduceVoice(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (state) {
    case "idle":
      return event.type === "press" ? "armed" : state;

    case "armed":
      if (event.type === "armDelayElapsed") return "recording";
      // Released before arming: a tap, not a recording.
      if (event.type === "release" || event.type === "cancel") return "idle";
      return state;

    case "recording":
      if (event.type === "pan") {
        if (event.dy < LOCK_DY) return "locked";
        if (event.dx < CANCEL_DX) return "cancelled";
        return state;
      }
      if (event.type === "release") return "finished";
      if (event.type === "cancel") return "cancelled";
      return state;

    case "locked":
      // Hands-free: the finger is already up, so release means nothing here.
      if (event.type === "stop") return "finished";
      if (event.type === "cancel") return "cancelled";
      return state;

    default:
      return state;
  }
}

// The single source of truth for "does this clip get uploaded?". Cancelling
// must never reach useResolveVoice — that is the one transition with a direct
// cost consequence if it is wrong.
export function shouldUpload(state: VoiceState): boolean {
  return state === "finished";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --ci --forceExit src/capture/__tests__/voiceRecording.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-verify**

Make each change, run the test file, confirm the named test fails on its own assertion, then revert and confirm `git diff` is clean:

1. In `reduceVoice`, `case "armed"`: change `if (event.type === "release" || event.type === "cancel") return "idle";` to `return "recording";` → *"a press released before the arm delay never records"* must fail.
2. In `case "recording"`, swap the order so `if (event.dx < CANCEL_DX)` is checked before the `dy` lock check, and call `reduceVoice(rec, {type:"pan", dx: CANCEL_DX - 1, dy: LOCK_DY - 1})` mentally — instead, simply change `shouldUpload` to `return state !== "idle";` → *"only the finished state ever uploads"* and *"sliding left past the cancel threshold discards the clip"* must fail.
3. Change `CANCEL_DX` to `-8` → *"thresholds match the spec"* must fail.

- [ ] **Step 6: Commit**

```bash
git add src/capture/voiceRecording.ts src/capture/__tests__/voiceRecording.test.ts
git commit -m "feat(mobile): pure state machine for hold-to-record voice capture"
```

---

### Task 2: Mode-aware composer

**Files:**
- Modify: `app/capture.tsx` (composer block around lines 530-575; the quick-capture `Pressable`, the `TextInput`, and the Send `Pressable`)
- Modify: `app/__tests__/capture.test.tsx` (reroute the photo tests — see Step 3)
- Test: `app/__tests__/capture-composer-modes.test.tsx`

**Interfaces:**
- Consumes: `CaptureMode` from `app/capture.tsx`.
- Produces: composer renders a mode-specific left button with accessibility labels `"Quick photo capture"` (photo), `"Hold to record"` (voice), `"Scan a barcode"` (scan), `"Focus the message field"` (type); the `"Tell Otto what you ate"` `TextInput` and `"Send"` button render **only** in `photo` and `type`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@testing-library/react-native";
import CaptureScreen from "../capture";

// Renders the capture screen and switches to `mode` via its pill.
async function renderInMode(mode: "Photo" | "Voice" | "Scan" | "Type") {
  const utils = render(<CaptureScreen />);
  const { fireEvent, findByLabelText } = utils;
  if (mode !== "Photo") fireEvent.press(await findByLabelText(new RegExp(`${mode}$`)));
  return utils;
}

test("voice mode shows a hold-to-record control and hides the text field", async () => {
  const { findByLabelText, queryByLabelText } = await renderInMode("Voice");
  expect(await findByLabelText("Hold to record")).toBeTruthy();
  expect(queryByLabelText("Quick photo capture")).toBeNull();
  expect(queryByLabelText("Tell Otto what you ate")).toBeNull();
  expect(queryByLabelText("Send")).toBeNull();
});

test("scan mode shows a barcode control and hides the text field", async () => {
  const { findByLabelText, queryByLabelText } = await renderInMode("Scan");
  expect(await findByLabelText("Scan a barcode")).toBeTruthy();
  expect(queryByLabelText("Quick photo capture")).toBeNull();
  expect(queryByLabelText("Tell Otto what you ate")).toBeNull();
});

test("photo mode keeps the camera button and the text field", async () => {
  const { findByLabelText } = await renderInMode("Photo");
  expect(await findByLabelText("Quick photo capture")).toBeTruthy();
  expect(await findByLabelText("Tell Otto what you ate")).toBeTruthy();
});

test("type mode shows a keyboard control and the text field", async () => {
  const { findByLabelText, queryByLabelText } = await renderInMode("Type");
  expect(await findByLabelText("Focus the message field")).toBeTruthy();
  expect(await findByLabelText("Tell Otto what you ate")).toBeTruthy();
  expect(queryByLabelText("Quick photo capture")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --ci --forceExit app/__tests__/capture-composer-modes.test.tsx`
Expected: FAIL — `Hold to record` not found; `Quick photo capture` is present in every mode.

- [ ] **Step 3: Implement**

In `app/capture.tsx`, replace the hardcoded quick-capture `Pressable` with a mode-aware left control, and gate the `TextInput`/Send on the mode. Add above the composer's return:

```tsx
const showsTextField = mode === "photo" || mode === "type";
```

Replace the quick-capture `Pressable` with:

```tsx
{/* Mode-aware primary control. Previously a camera in EVERY mode, which is
    what made Voice read as a photo capture. The voice branch is the
    hold-to-record target (Task 3). */}
{mode === "voice" ? (
  <VoiceComposerButton
    isRecording={isRecordingVoice}
    onStart={onStartVoice}
    onFinish={onFinishVoice}
    onCancel={onCancelVoice}
  />
) : (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={
      mode === "scan" ? "Scan a barcode" : mode === "type" ? "Focus the message field" : "Quick photo capture"
    }
    onPress={mode === "scan" || mode === "type" ? () => onModeChange(mode) : onCapturePhoto}
    style={{
      width: 38,
      height: 38,
      borderRadius: 9999,
      backgroundColor: captureColors.primary,
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <Icon
      name={mode === "scan" ? "scan-barcode" : mode === "type" ? "type" : "camera"}
      size={19}
      color={captureColors.primaryForeground}
    />
  </Pressable>
)}
```

Wrap the `TextInput` and the Send `Pressable` in `{showsTextField && ( … )}`. For `scan` and `voice`, render static guidance in the middle instead:

```tsx
{showsTextField ? (
  <TextInput
    accessibilityLabel="Tell Otto what you ate"
    value={text}
    onChangeText={onChangeText}
    placeholder="Tell Otto what you ate…"
    placeholderTextColor={captureColors.onSurfaceFaint}
    style={{ flex: 1, color: captureColors.onSurface, fontSize: 15 }}
  />
) : (
  <AppText style={{ flex: 1, color: captureColors.onSurfaceFaint, fontSize: 15 }}>
    {mode === "voice" ? "Hold the mic to record" : "Point at a barcode"}
  </AppText>
)}
```

For this task only, stub `VoiceComposerButton` in `app/capture.tsx` so the file compiles; Task 3 replaces it with the real component:

```tsx
function VoiceComposerButton({ onStart }: { isRecording: boolean; onStart: () => void; onFinish: () => void; onCancel: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Hold to record"
      onPress={onStart}
      style={{ width: 38, height: 38, borderRadius: 9999, backgroundColor: captureColors.primary, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="mic" size={19} color={captureColors.primaryForeground} />
    </Pressable>
  );
}
```

Wire `onStartVoice`/`onFinishVoice`/`onCancelVoice` to the existing `handleToggleVoice` for now (Task 3 splits them).

- [ ] **Step 4: Reroute the existing photo tests**

`app/__tests__/capture.test.tsx` reaches the photo flow via the quick-capture button from the **Type** tab. That button no longer exists there. In each such test, press the Photo pill first:

```tsx
fireEvent.press(await findByLabelText(/Photo$/));
fireEvent.press(await findByLabelText("Quick photo capture"));
```

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx jest --ci --forceExit`
Expected: PASS. Suite count 110, tests 717+.

- [ ] **Step 6: Mutation-verify**

Revert the `showsTextField` gate so the `TextInput` always renders → *"voice mode shows a hold-to-record control and hides the text field"* must fail on the `Tell Otto what you ate` assertion. Revert; confirm clean `git diff`.

- [ ] **Step 7: Commit**

```bash
git add app/capture.tsx app/__tests__/capture.test.tsx app/__tests__/capture-composer-modes.test.tsx
git commit -m "feat(mobile): make the capture composer reflect the selected mode"
```

---

### Task 3: VoiceComposer gesture component

**Files:**
- Create: `src/components/capture/VoiceComposer.tsx`
- Modify: `app/capture.tsx` (delete the Task 2 stub, import the real component, split `handleToggleVoice` into start/finish/cancel)
- Test: `src/components/capture/__tests__/VoiceComposer.test.tsx`

**Interfaces:**
- Consumes: `reduceVoice`, `initialVoiceState`, `shouldUpload`, `PRESS_ARM_MS`, `CANCEL_DX`, `LOCK_DY` from `src/capture/voiceRecording`.
- Produces: `VoiceComposer` with props `{ isRecording: boolean; onStart: () => void; onFinish: () => void; onCancel: () => void }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render } from "@testing-library/react-native";
import { VoiceComposer } from "../VoiceComposer";

// NOTE ON WHAT THIS FILE DOES AND DOES NOT PROVE.
// react-native-gesture-handler is mocked in jest.setup.js, so a synthesised
// pan would exercise the mock, not the app — that is the vacuous-green pattern
// that hid #82. The pan-driven transitions are covered for real in
// src/capture/__tests__/voiceRecording.test.ts against the pure reducer. What
// IS asserted here is the accessible, gesture-free path, which must work
// because hold-and-slide is unusable under VoiceOver.
test("the accessible tap path starts and then finishes a recording", () => {
  const onStart = jest.fn();
  const onFinish = jest.fn();
  const onCancel = jest.fn();
  const { getByLabelText, rerender } = render(
    <VoiceComposer isRecording={false} onStart={onStart} onFinish={onFinish} onCancel={onCancel} />,
  );

  fireEvent.press(getByLabelText("Hold to record"));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onFinish).not.toHaveBeenCalled();

  rerender(<VoiceComposer isRecording onStart={onStart} onFinish={onFinish} onCancel={onCancel} />);
  fireEvent.press(getByLabelText("Stop recording"));
  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});

test("cancelling while recording discards instead of finishing", () => {
  const onFinish = jest.fn();
  const onCancel = jest.fn();
  const { getByLabelText } = render(
    <VoiceComposer isRecording onStart={jest.fn()} onFinish={onFinish} onCancel={onCancel} />,
  );

  fireEvent.press(getByLabelText("Cancel recording"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onFinish).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --ci --forceExit src/components/capture/__tests__/VoiceComposer.test.tsx`
Expected: FAIL — `Cannot find module '../VoiceComposer'`.

- [ ] **Step 3: Implement**

```tsx
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { captureColors } from "@/components/capture/captureTheme";
import {
  CANCEL_DX,
  LOCK_DY,
  PRESS_ARM_MS,
  initialVoiceState,
  reduceVoice,
  shouldUpload,
  type VoiceState,
} from "@/capture/voiceRecording";

interface VoiceComposerProps {
  isRecording: boolean;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
}

// Thin glue: it turns gestures into events for reduceVoice and reports the
// result. All decisions live in the reducer, which is testable; this layer is
// deliberately small because the gesture itself cannot be tested here.
export function VoiceComposer({ isRecording, onStart, onFinish, onCancel }: VoiceComposerProps) {
  const [state, setState] = useState<VoiceState>(initialVoiceState);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function apply(next: VoiceState, previous: VoiceState) {
    setState(next);
    if (previous !== "recording" && previous !== "locked" && (next === "recording" || next === "locked")) onStart();
    if (next === "cancelled") {
      onCancel();
      setState("idle");
    }
    if (shouldUpload(next)) {
      onFinish();
      setState("idle");
    }
  }

  function send(event: Parameters<typeof reduceVoice>[1]) {
    setState((current) => {
      const next = reduceVoice(current, event);
      if (next !== current) queueMicrotask(() => apply(next, current));
      return current;
    });
  }

  const pan = Gesture.Pan()
    .onBegin(() => {
      send({ type: "press" });
      armTimer.current = setTimeout(() => send({ type: "armDelayElapsed" }), PRESS_ARM_MS);
    })
    .onUpdate((e) => send({ type: "pan", dx: e.translationX, dy: e.translationY }))
    .onFinalize(() => {
      if (armTimer.current) clearTimeout(armTimer.current);
      send({ type: "release" });
    });

  const active = isRecording || state === "recording" || state === "locked";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <GestureDetector gesture={pan}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={active ? "Stop recording" : "Hold to record"}
          accessibilityHint={active ? undefined : "Hold to record, slide left to cancel, swipe up to lock"}
          onPress={() => (active ? onFinish() : onStart())}
          style={{
            width: 38,
            height: 38,
            borderRadius: 9999,
            backgroundColor: captureColors.primary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="mic" size={19} color={captureColors.primaryForeground} />
        </Pressable>
      </GestureDetector>

      {active ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel recording" onPress={onCancel}>
          <AppText style={{ color: captureColors.onSurfaceMuted, fontSize: 13 }}>Cancel</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
```

In `app/capture.tsx`: delete the Task 2 stub, `import { VoiceComposer } from "@/components/capture/VoiceComposer";`, render it in the voice branch, and split `handleToggleVoice` into `handleStartVoice` (permission + `prepareToRecordAsync` + `record`) and `handleFinishVoice` (`stop` + `resolveVoice.mutate`) plus `handleCancelVoice` (`stop`, discard the uri, **no mutate**).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx jest --ci --forceExit`
Expected: PASS. Suite count 111.

- [ ] **Step 5: Mutation-verify**

Change `handleCancelVoice` to call `resolveVoice.mutate(...)` → the Task 4 cancel test must fail. Change the `Cancel recording` handler to `onFinish` → *"cancelling while recording discards instead of finishing"* must fail. Revert each; confirm clean `git diff`.

- [ ] **Step 6: Commit**

```bash
git add src/components/capture/VoiceComposer.tsx src/components/capture/__tests__/VoiceComposer.test.tsx app/capture.tsx
git commit -m "feat(mobile): hold-to-record voice composer with slide-to-cancel and lock"
```

---

### Task 4: Cancel must not upload, and IdleAffordance becomes display-only

**Files:**
- Modify: `app/capture.tsx` (`IdleAffordance` voice branch: drop `onToggleVoice`, keep waveform/caption)
- Test: `app/__tests__/capture-voice-cancel.test.tsx`

**Interfaces:**
- Consumes: `VoiceComposer` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import CaptureScreen from "../capture";
import { useResolveVoice } from "@/api/hooks";

jest.mock("@/api/hooks", () => {
  const actual = jest.requireActual("@/api/hooks");
  return { ...actual, useResolveVoice: jest.fn() };
});

// The one transition with a direct cost consequence: a cancelled clip must
// never reach the paid transcription endpoint.
test("cancelling a recording never calls the resolve mutation", async () => {
  const mutate = jest.fn();
  (useResolveVoice as jest.Mock).mockReturnValue({ mutate, isPending: false });

  const { findByLabelText } = render(<CaptureScreen />);
  fireEvent.press(await findByLabelText(/Voice$/));
  fireEvent.press(await findByLabelText("Hold to record"));
  fireEvent.press(await findByLabelText("Cancel recording"));

  await waitFor(() => expect(mutate).not.toHaveBeenCalled());
});

test("the idle voice affordance is no longer a button", async () => {
  (useResolveVoice as jest.Mock).mockReturnValue({ mutate: jest.fn(), isPending: false });
  const { findByLabelText, queryByLabelText } = render(<CaptureScreen />);
  fireEvent.press(await findByLabelText(/Voice$/));
  // The 72px mic in the thread is now a state display; the composer owns input.
  expect(queryByLabelText("Start recording")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --ci --forceExit app/__tests__/capture-voice-cancel.test.tsx`
Expected: FAIL — `Start recording` still present in `IdleAffordance`.

- [ ] **Step 3: Implement**

In `IdleAffordance`'s `mode === "voice"` branch, replace the `Pressable` mic with a non-interactive `View` of the same dimensions, drop the `onToggleVoice` prop from `IdleAffordanceProps` and its call site, and change the caption to `isRecordingVoice ? "Listening… tell Otto what you ate" : "Hold the mic below to record"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx jest --ci --forceExit`
Expected: PASS. Suite count 112.

- [ ] **Step 5: Mutation-verify**

Restore the `Pressable` in `IdleAffordance` → *"the idle voice affordance is no longer a button"* must fail. Revert; confirm clean `git diff`.

- [ ] **Step 6: Commit**

```bash
git add app/capture.tsx app/__tests__/capture-voice-cancel.test.tsx
git commit -m "feat(mobile): idle voice affordance becomes a state display, not a second control"
```

---

### Task 5: Update the UI kit so it stops encoding the bug

**Files:**
- Modify: `design-system/ui_kits/kora/CaptureScreen.jsx:148-156`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by code — this is the fidelity reference.

- [ ] **Step 1: Implement**

The mockup hardcodes `<DS.Icon name="camera" …>` in the composer for every mode, which is the defect the app faithfully reproduced. Make it mode-aware and hide the text field outside `photo`/`type`:

```jsx
<button onClick={input === "voice" ? undefined : analyze} style={{ width: 38, height: 38, borderRadius: "var(--radius-full)", background: "var(--primary)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
  <DS.Icon name={input === "voice" ? "mic" : input === "scan" ? "scan-barcode" : input === "type" ? "type" : "camera"} size={19} color="var(--primary-foreground)" />
</button>
{(input === "photo" || input === "type") ? (
  <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell Otto what you ate…"
    style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#fff", fontSize: 15, fontFamily: "var(--font-sans)" }} />
) : (
  <span style={{ flex: 1, color: "rgba(255,255,255,0.45)", fontSize: 15, fontFamily: "var(--font-sans)" }}>
    {input === "voice" ? "Hold the mic to record" : "Point at a barcode"}
  </span>
)}
```

Add above it a comment recording why, so the next fidelity review does not revert it:

```jsx
{/* Mode-aware: a camera icon in EVERY mode is what made Voice read as a photo
    capture in the shipped app. Keep this in step with apps/mobile/app/capture.tsx. */}
```

- [ ] **Step 2: Verify**

Open `design-system/ui_kits/kora/index.html` in a browser, select the Voice pill, and confirm the composer shows a mic and no text field.

- [ ] **Step 3: Commit**

```bash
git add design-system/ui_kits/kora/CaptureScreen.jsx
git commit -m "fix(ui-kit): composer reflects the selected capture mode"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — exit 0
- [ ] `npx jest --ci --forceExit` — all green, suite count 112, tests ≥ 725
- [ ] `git status` shows no `eslint.config.js` and no `eslint*` additions in `package.json`
- [ ] Every new test has been mutation-verified as described in its task

**Known limits — state these in the PR, do not paper over them:**
- The pan gesture is not covered by any test. gesture-handler is mocked; the pan-driven transitions are covered against the pure reducer instead.
- Recording cannot be exercised on the simulator (`prepareToRecordAsync()` rejects). Verified 2026-08-04.
- Voice has still never completed end to end in production. This changes the interface, not the pipeline.
