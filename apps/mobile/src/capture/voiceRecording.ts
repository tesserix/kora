// Pure recording state machine for voice capture.
//
// Deliberately free of React, react-native-gesture-handler and expo-audio. The
// pan gesture cannot be meaningfully simulated under Jest — gesture-handler is
// mocked in jest.setup.js, so a synthesised pan would exercise the mock rather
// than the app, which is precisely the vacuous-green pattern that let #82 ship
// broken behind a suite of passing tests. So every decision lives here, where
// it can be tested against real inputs, and the gesture wiring in
// VoiceComposer stays thin enough to review by eye.
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

// Horizontal slide (leftwards, hence negative) that abandons the clip.
export const CANCEL_DX = -80;

// Vertical swipe (upwards, hence negative) that locks into hands-free
// recording. Checked before the cancel threshold so that a diagonal swipe
// resolves to the non-destructive outcome.
export const LOCK_DY = -60;

export const initialVoiceState: VoiceState = "idle";

export function reduceVoice(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (state) {
    case "idle":
      return event.type === "press" ? "armed" : state;

    case "armed":
      if (event.type === "armDelayElapsed") return "recording";
      // Released before arming: that was a tap, not a recording.
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
      // Hands-free: the finger is already up, so a release means nothing here.
      // Only an explicit Stop or Cancel ends it.
      if (event.type === "stop") return "finished";
      if (event.type === "cancel") return "cancelled";
      return state;

    default:
      return state;
  }
}

// The single gate in front of a paid transcription call. A cancelled clip must
// never reach useResolveVoice — that is the one transition here with a direct
// cost consequence if it is wrong.
export function shouldUpload(state: VoiceState): boolean {
  return state === "finished";
}
