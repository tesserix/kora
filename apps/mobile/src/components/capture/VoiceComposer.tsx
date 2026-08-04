import { useRef } from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { captureColors } from "@/components/capture/captureTheme";
import {
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

  const pan = Gesture.Pan()
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

      {isRecording ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel recording"
          onPress={() => {
            stateRef.current = initialVoiceState;
            onCancel();
          }}
        >
          <AppText style={{ color: captureColors.onSurfaceMuted, fontSize: 13, fontWeight: "600" }}>Cancel</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
