import { type ReactNode, useEffect } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { springs } from "@/motion/springs";
import { useMotionPrefs } from "@/motion/useMotionPrefs";
import { useTheme } from "@/theme";
import { REDUCED_TRANSPARENCY_FALLBACK } from "@/components/instrument/GlassPanel";

interface Props { visible: boolean; onClose: () => void; children: ReactNode }

// Instrument Glass surface (spec: Sheet.tsx > "surface from colors.card
// (green-tinted) → dark-elevated instrument surface"). Shares the exact
// scheme-aware fallback tones GlassPanel uses for reduced transparency —
// they read as "elevated instrument surface" whether or not the sheet is
// blurred, so a plain (non-blurred) sheet and a reduced-transparency glass
// panel look like the same material. This closes review finding I7 (meal
// detail's sheet was the last surface still on the old green card color).
export function Sheet({ visible, onClose, children }: Props) {
  const { radius, scheme, instrument } = useTheme();
  const surface = REDUCED_TRANSPARENCY_FALLBACK[scheme];
  const { reduceMotion } = useMotionPrefs();
  const { height: screenH } = useWindowDimensions();
  const translateY = useSharedValue(screenH);

  useEffect(() => {
    if (visible) translateY.value = reduceMotion ? 0 : withSpring(0, springs.standard);
  }, [visible, reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = () => {
    if (reduceMotion) { onClose(); return; }
    translateY.value = withSpring(screenH, springs.lively, (done) => { if (done) runOnJS(onClose)(); });
  };

  const pan = Gesture.Pan()
    .onChange((e) => {
      const next = translateY.value + e.changeY;
      // rubber-band above rest position
      translateY.value = next >= 0 ? next : next / 3;
    })
    .onEnd((e) => {
      const shouldClose = e.velocityY > 500 || (translateY.value > 120 && e.velocityY > -200);
      if (shouldClose) {
        translateY.value = withSpring(screenH, { ...springs.lively, velocity: e.velocityY }, (done) => { if (done) runOnJS(onClose)(); });
      } else {
        translateY.value = withSpring(0, { ...springs.standard, velocity: e.velocityY });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, screenH], [1, 0]),
  }));

  if (!visible) return null;
  return (
    <Modal visible transparent animationType={reduceMotion ? "fade" : "none"} onRequestClose={dismiss}>
      {/* Every sheet in the app is bottom-anchored, so a raised keyboard sits
          exactly on top of its content. FoodPicker is the worst case and the
          reason this is here (kora#182): its TextInput is at the top and the
          results list below it, so typing a correction worked but seeing or
          tapping the result did not — the correction journey was impossible to
          finish on a device.

          Fixed in Sheet rather than in FoodPicker because all eleven sheets
          with a text input inherit the same defect. `behavior="padding"`
          matches the pattern already proven in app/sign-in.tsx; it shrinks the
          parent, and since the sheet is sized `maxHeight: "82%"` OF that
          parent, the sheet shrinks with it instead of being clipped.

          iOS only: on Android `windowSoftInputMode` already resizes the
          window, and adding padding on top of that double-compensates. */}
      <KeyboardAvoidingView
        testID="sheet-keyboard-avoider"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Animated.View style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.4)" }, scrimStyle]}>
          <Pressable accessibilityLabel="Close" onPress={dismiss} style={{ flex: 1 }} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              { maxHeight: "82%", backgroundColor: surface, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"] },
              sheetStyle,
            ]}
          >
            <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 5, borderRadius: 999, backgroundColor: instrument.mut }} />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          </Animated.View>
        </GestureDetector>
      </KeyboardAvoidingView>
    </Modal>
  );
}
