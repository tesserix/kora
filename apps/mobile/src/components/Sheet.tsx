import { type ReactNode, useEffect } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { springs } from "@/motion/springs";
import { useMotionPrefs } from "@/motion/useMotionPrefs";
import { useTheme } from "@/theme";

interface Props { visible: boolean; onClose: () => void; children: ReactNode }

export function Sheet({ visible, onClose, children }: Props) {
  const { colors, radius } = useTheme();
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
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.4)" }, scrimStyle]}>
          <Pressable accessibilityLabel="Close" onPress={dismiss} style={{ flex: 1 }} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              { maxHeight: "82%", backgroundColor: colors.card, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"] },
              sheetStyle,
            ]}
          >
            <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 5, borderRadius: 999, backgroundColor: colors.tertiaryLabel }} />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}
