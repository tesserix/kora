# Voice hold-to-record + mode-aware composer — design

**Date:** 2026-08-04
**Status:** approved, not implemented

## Problem

On the capture screen the composer's left button is a **camera icon in every
mode**, including Voice. Selecting the Voice pill changes the pill row and the
thread affordance but leaves the composer showing a camera button and a
"Tell Otto what you ate…" text field — controls that do nothing for voice.

The reference design has the same defect. `design-system/ui_kits/kora/
CaptureScreen.jsx:150` hardcodes `<DS.Icon name="camera" …>` in the composer
regardless of `input` mode. **The app is faithfully reproducing a flawed
mockup**, so this is not fidelity drift — and the kit must be updated alongside
the app, or the next fidelity review will "correct" the fix back out.

Secondary problem: recording is tap-to-start/tap-to-stop, which makes accidental
recordings easy and gives no way to abandon a clip once started.

## Goals

- The composer reflects the selected mode.
- Voice recording is hold-to-record, with slide-to-cancel and swipe-to-lock.
- Recording remains fully usable without gestures (accessibility).

## Non-goals

- Changing the resolve/upload pipeline. `useResolveVoice` and `buildFileForm`
  are untouched.
- Changing the mode pill row.
- Waveform visual redesign. The existing `Waveform` component is reused.

## Design

### One control, not two

There are currently two voice controls: a 72px mic inside `IdleAffordance`
(`app/capture.tsx`, `mode === "voice"`) and the composer button. Hold-to-record
goes on the **composer** button:

- slide-to-cancel and swipe-to-lock need to sit in thumb reach at the bottom of
  the screen;
- it matches the interaction users already know from messaging apps;
- two independently pressable mics would compete.

`IdleAffordance`'s voice branch stops being a button and becomes the **state
display**: live waveform, elapsed timer, and hint text. It no longer receives
`onToggleVoice`.

### Mode-aware composer

| Mode  | Left button      | Middle                              | Right |
|-------|------------------|-------------------------------------|-------|
| photo | camera           | "Tell Otto what you ate…" (input)   | send  |
| voice | **mic** (hold)   | hint / slide + lock affordance      | —     |
| scan  | barcode          | "Point at a barcode" (static)       | —     |
| type  | keyboard         | "Tell Otto what you ate…" (input)   | send  |

The text field and send button render only in `photo` and `type`. In `voice`
and `scan` the middle region is non-editable guidance.

### Recording state machine

```
idle ──press──> armed ──(held > 200ms)──> recording
                  │                          ├─ dx < -80  ──> cancelled   (no upload)
                  │                          ├─ dy < -60  ──> locked
                  │                          └─ release   ──> finished    (upload)
                  └─ release <= 200ms ──> idle + "Hold to record" hint

locked ──[Stop]──> finished (upload)
locked ──[Cancel]──> cancelled (no upload)
```

Thresholds: `PRESS_ARM_MS = 200`, `CANCEL_DX = -80`, `LOCK_DY = -60`.

A press shorter than `PRESS_ARM_MS` is a mis-tap: it shows the hint and does
**not** start a recording, so a stray tap cannot fire a 0.2s clip at a paid
transcription endpoint.

`cancelled` must call `recorder.stop()` and discard the uri without invoking
`useResolveVoice`. This is the one transition with a cost consequence if wrong.

### Where the code goes

New: `src/capture/voiceRecording.ts` — the state machine as a **pure module**
(no React, no gesture-handler, no expo-audio). Exports the state type, the
threshold constants, and a `reduce(state, event)` transition function.

New: `src/components/capture/VoiceComposer.tsx` — the mic button, gesture
wiring (`Gesture.Pan()` via the existing `react-native-gesture-handler`), and
the locked-state controls. Thin: it translates gestures into events for the
reducer and renders the result.

Modified: `app/capture.tsx` — composer becomes mode-aware; `IdleAffordance`'s
voice branch becomes display-only.

Modified: `design-system/ui_kits/kora/CaptureScreen.jsx` — the mockup's
composer becomes mode-aware so the kit and the app agree.

### Accessibility

- The mic keeps a **tap-to-start / tap-to-stop** path. Hold-and-slide is
  unusable under VoiceOver and hostile to motor impairment; the gesture is an
  accelerator, never the only route.
- `accessibilityActions` on the mic expose start/stop/cancel explicitly.
- The locked state exists partly for this: it is the hands-free mode.
- `prefers-reduced-motion` is already honoured by `Waveform`; follow it for any
  new motion.
- Elapsed time is exposed via `accessibilityValue`, not colour or motion alone.

## Testing

**Testable, and will be tested properly:**

- `voiceRecording.ts` in full: every transition, both thresholds, the
  short-press rejection, and that `cancelled` never yields an upload.
- Rendered composer per mode: correct button, and the text field/send button
  absent in `voice`/`scan`.
- That cancelling does not call the resolve mutation.

**NOT meaningfully testable here, and will not be faked:**

- The pan gesture itself. `react-native-gesture-handler` is mocked in
  `jest.setup.js`; a test asserting on a synthesised pan would verify the mock,
  not the app. This is exactly the vacuous-green pattern that hid #82. The
  gesture wiring is deliberately kept thin so that what cannot be tested is also
  trivial.
- Actual recording. **The simulator cannot record** — `prepareToRecordAsync()`
  rejects and the app surfaces "Something went wrong starting the recording".
  Verified 2026-08-04. The record → upload → transcribe loop requires a physical
  device.

Every new test must be mutation-verified per the house rule: break the
behaviour it names, confirm it fails on its own assertion, revert, confirm a
clean `git diff`.

## Consequences

- **The always-visible "Quick photo capture" shortcut is removed.** Today the
  composer's camera button fires the photo flow from any tab, including Type.
  Mode-awareness means switching to Photo first. Accepted deliberately: that
  button is the reported confusion.
- **A capture test must be rerouted.** `app/__tests__/capture.test.tsx` reaches
  the photo flow through that shortcut from the Type tab, because the viewfinder
  only renders in Photo mode. It will need to switch modes first. The test's
  intent is unchanged; only its route is.

## Risks

- Voice has **never been exercised end to end by anyone**. This work improves
  the interface to a path that has never successfully run. It should not be
  read as making voice work.
- Independently of this change, the voice MIME is unproven: we send
  `audio/mp4`, which is not in Gemini's documented set
  (wav/mp3/aiff/aac/ogg/flac). The first successful recording may still fail at
  transcription. #87's error logging will now say so plainly.
