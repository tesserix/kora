import { useRef } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import {
  PRESS_ARM_MS,
  initialVoiceState,
  reduceVoice,
  shouldUpload,
  type VoiceState,
} from "@/capture/voiceRecording";

const T = INSTRUMENT_DARK_FIXED;

interface VoiceComposerProps {
  isRecording: boolean;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
}

// Thin glue between the pan gesture and the pure reducer in
// src/capture/voiceRecording.ts. Every decision — when a press becomes a
// recording, which drag distance cancels, which locks — lives in the reducer,
// where it is tested against real inputs. This layer only translates gestures
// into events and reports the outcome, and it is kept deliberately small
// because react-native-gesture-handler is mocked under Jest: a test that drove
// a synthesised pan through here would be exercising the mock, not the app.
//
// The Pressable inside the GestureDetector is not redundant. Hold-and-slide is
// unusable under VoiceOver and hostile to motor impairment, so tap-to-start /
// tap-to-stop is a first-class path, not a fallback.
export function VoiceComposer({ isRecording, onStart, onFinish, onCancel }: VoiceComposerProps) {
  // A ref, not state: the gesture callbacks need the current value without
  // re-subscribing, and nothing renders off it directly (the visible state is
  // driven by `isRecording`, which the screen owns).
  const stateRef = useRef<VoiceState>(initialVoiceState);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function send(event: Parameters<typeof reduceVoice>[1]) {
    const previous = stateRef.current;
    const next = reduceVoice(previous, event);
    if (next === previous) return;
    stateRef.current = next;

    const wasRecording = previous === "recording" || previous === "locked";
    const isNowRecording = next === "recording" || next === "locked";
    if (!wasRecording && isNowRecording) onStart();

    if (next === "cancelled") {
      onCancel();
      stateRef.current = initialVoiceState;
      return;
    }
    if (shouldUpload(next)) {
      onFinish();
      stateRef.current = initialVoiceState;
    }
  }

  function clearArmTimer() {
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  }

  // runOnJS(true) is what stops this crashing the app.
  //
  // With Reanimated installed, RNGH runs gesture callbacks on the UI thread as
  // worklets by default. Every callback below reaches plain JS: `send` closes
  // over React callbacks, `clearArmTimer` mutates a ref, and `setTimeout` is a
  // JS-runtime API. Invoking any of those from a worklet tears down the UI
  // runtime — the app dies the moment the mic is touched.
  //
  // TickRuler solves the same problem the other way, wrapping each call in
  // runOnJS(...). Here the ENTIRE gesture is JS-side glue over a pure reducer,
  // so flipping the whole gesture is simpler and leaves no callback able to
  // drift back onto the UI thread later.
  //
  // Jest cannot catch this: RNGH is mocked, so a synthesised pan exercises the
  // mock rather than the worklet boundary — this file's own comment says as
  // much. It is the third UI-runtime crash of this shape in this codebase.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .onBegin(() => {
      send({ type: "press" });
      clearArmTimer();
      armTimer.current = setTimeout(() => send({ type: "armDelayElapsed" }), PRESS_ARM_MS);
    })
    .onUpdate((e) => send({ type: "pan", dx: e.translationX, dy: e.translationY }))
    .onFinalize(() => {
      clearArmTimer();
      send({ type: "release" });
    });

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <GestureDetector gesture={pan}>
        {/* MUST stay a raw Pressable — NOT PressableScale (kora#175 regression,
            crashed on device in build 21).

            GestureDetector attaches to its child by cloning it with a ref to
            reach the underlying native view. `PressableScale` is a plain
            function component and forwards no ref, so RNGH gets nothing to
            attach to and the screen crashes on mount. Every other
            GestureDetector in the app hands it a host component (`View` in
            TickRuler, `Animated.View` in Sheet), which is why this was the only
            site that broke.

            The press-down feedback kora#175 wanted is still here, via the
            `pressed` style callback — the same idiom used in ModePill and
            DetectedCard. It covers the 200ms PRESS_ARM_MS window without
            needing a ref. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isRecording ? "Stop recording" : "Hold to record"}
          accessibilityHint={
            isRecording ? undefined : "Hold to record, slide left to cancel, or swipe up to record hands-free"
          }
          onPress={() => {
            stateRef.current = initialVoiceState;
            if (isRecording) onFinish();
            else onStart();
          }}
          style={(s) => ({
            width: 38,
            height: 38,
            borderRadius: 9999,
            // The mic button is this surface's single primary action — the
            // one place accent orange is allowed here.
            backgroundColor: T.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: s.pressed ? 0.6 : 1,
          })}
        >
          <Icon name="mic" size={19} color={T.accentOn} />
        </Pressable>
      </GestureDetector>

      {isRecording ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel recording"
          onPress={() => {
            stateRef.current = initialVoiceState;
            onCancel();
          }}
          style={(s) => ({ opacity: s.pressed ? 0.6 : 1 })}
        >
          <AppText style={{ color: T.mut, fontSize: 13, fontWeight: "600" }}>Cancel</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
