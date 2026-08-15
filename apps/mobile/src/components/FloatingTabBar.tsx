import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
import { useReducedTransparency, REDUCED_TRANSPARENCY_FALLBACK } from "./instrument/GlassPanel";
import { PressableScale, springs, useMotionPrefs } from "@/motion";
import { useUnreadCount } from "@/api/hooks";

const TAB_META: Record<string, { icon: string; label: string }> = {
  index: { icon: "house", label: "Today" },
  diary: { icon: "book-open", label: "Diary" },
  progress: { icon: "chart-line", label: "Trends" },
  more: { icon: "grid-2x2", label: "More" },
};

const ORDER_LEFT = ["index", "diary"];
const ORDER_RIGHT = ["progress", "more"];

// Camera cap is raised above the pill (see CaptureButton). The pill spans the
// full width (24px side insets, per the instrument glass spec) with the tabs
// in equal flex slots and a flex slot in the middle reserved for the raised
// camera.
const CAMERA_SIZE = 52;
const CAMERA_RAISE = 16;

// Tab slot is 52x52 — above the 44pt a11y floor with room to spare, and the
// painted area the sliding well tracks.
const TAB_SIZE = 52;

// Dock v2 (spec 2026-08-16 "Panel architecture" + "dock v2"): the bar's own
// rim gradient, inlined rather than reused from BezelCluster — different
// radii/stops, so a shared abstraction would be premature.
const RIM_INSET = 1.5;
const PILL_RADIUS = 31;
const PILL_CONTENT_RADIUS = PILL_RADIUS - RIM_INSET;
// minHeight, not height (kora#177): the pill clips with overflow:"hidden",
// and its content includes a label that grows with Dynamic Type. It has to
// be free to grow with it. Dropped from 64 (kora#177) to 58 — dock v2's
// sliding well now carries most of the bar's visual weight itself.
const PILL_MIN_HEIGHT = 58;

// Sliding well: the dock capsule silhouette miniaturized (spec "dock v2") —
// a full pill, not a rounded rectangle.
const WELL_HEIGHT = 44;
const WELL_RADIUS = 22;

// Domed capture face — precomputed [highlight, accent, shadow] mixes per
// scheme so the button reads as lit from above rather than a flat disc.
// Dark: base #FF4A00 lightened -> #FF8149, darkened -> #C93A00.
// Light: base #D23800 lightened -> #E2703D, darkened -> #A62C00.
const CAPTURE_FACE_GRADIENT = {
  dark: ["#FF8149", "#FF4A00", "#C93A00"],
  light: ["#E2703D", "#D23800", "#A62C00"],
} as const;

type FloatingTabBarProps = {
  state: { index: number; routes: ReadonlyArray<{ key: string; name: string }> };
  navigation: { navigate: (name: string) => void };
};

type TabButtonProps = {
  meta: { icon: string; label: string };
  active: boolean;
  showBadge: boolean;
  reduceMotion: boolean;
  onPress: () => void;
};

function TabButton({ meta, active, showBadge, reduceMotion, onPress }: TabButtonProps) {
  const { instrument } = useTheme();
  const scale = useSharedValue(1);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  // Icon pop on press (spec "dock v2"): a quick squash then a lively spring
  // back, distinct from the well's own slide. Skipped under Reduce Motion —
  // the well still jumps to the new tab, but nothing else pops.
  const handlePress = useCallback(() => {
    if (!reduceMotion) {
      scale.value = withSequence(withTiming(0.82, { duration: 140 }), withSpring(1, springs.lively));
    }
    onPress();
  }, [onPress, reduceMotion, scale]);

  return (
    <PressableScale
      accessibilityLabel={meta.label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      haptic="selection"
      onPress={handlePress}
      style={{ width: TAB_SIZE, height: TAB_SIZE, alignItems: "center", justifyContent: "center" }}
    >
      <Animated.View style={iconStyle}>
        <Icon name={meta.icon} size={22} color={active ? instrument.ink : instrument.mut} strokeWidth={active ? 2.5 : 2} />
      </Animated.View>
      {/* At 9px an engraved label separates by weight long before it
          separates by hue, so the inactive state is demoted twice over:
          `mut` at 500 and held back to 72% opacity, against full-opacity
          `ink` at 700. Always rendered (dock v2) — the label is no longer
          the active tab's exclusive tell, the sliding well is. */}
      <Text
        // The one place capping Dynamic Type is legitimate: a five-letter tab
        // label inside a fixed-width 52pt slot, backed up by an icon that
        // carries the same meaning. 1.6 keeps it legible (~14pt) without
        // letting a 310% setting push the pill to twice its height.
        maxFontSizeMultiplier={1.6}
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 1.4,
          fontWeight: active ? "700" : "500",
          opacity: active ? 1 : 0.72,
          color: active ? instrument.ink : instrument.mut,
        }}
      >
        {meta.label}
      </Text>
      {showBadge ? (
        <View
          testID="more-unread-badge"
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: instrument.accent,
            borderWidth: 1.5,
            borderColor: instrument.bg,
          }}
        />
      ) : null}
    </PressableScale>
  );
}

// Raised, glowing camera cap. Rendered as a SIBLING of the glass pill (not a
// child) — the pill uses overflow:"hidden" for its blur/border-radius, which
// would clip a button positioned above its top edge.
function CaptureButton() {
  const { instrument, scheme } = useTheme();

  return (
    <PressableScale
      accessibilityLabel="Capture"
      accessibilityRole="button"
      haptic="impactLight"
      onPress={() => router.push("/capture")}
      style={{
        width: CAMERA_SIZE,
        height: CAMERA_SIZE,
        borderRadius: CAMERA_SIZE / 2,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: instrument.accent,
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 10 },
        elevation: 10,
      }}
    >
      <LinearGradient
        testID="capture-face"
        colors={CAPTURE_FACE_GRADIENT[scheme]}
        style={[StyleSheet.absoluteFill, { borderRadius: CAMERA_SIZE / 2 }]}
      />
      <Icon name="camera" size={22} color={instrument.accentOn} />
    </PressableScale>
  );
}

export function FloatingTabBar({ state, navigation }: FloatingTabBarProps) {
  const { instrument, scheme } = useTheme();
  const reducedTransparency = useReducedTransparency();
  const { reduceMotion } = useMotionPrefs();
  const activeName = state.routes[state.index]?.name;
  const unread = useUnreadCount();
  const unreadCount = unread.data?.count ?? 0;

  // Per-tab {x, width} within the row, measured via onLayout on each slot and
  // recentered onto the fixed TAB_SIZE box the well actually tracks (slots
  // are flex:1, so their own width varies with available space; the button
  // inside each is centered and fixed-size).
  const layouts = useRef<Record<string, { x: number; width: number }>>({});
  const wellX = useSharedValue(0);
  const wellWidth = useSharedValue(TAB_SIZE);

  const positionWell = useCallback(
    (name: string | undefined) => {
      const layout = name ? layouts.current[name] : undefined;
      if (!layout) return;
      if (reduceMotion) {
        wellX.value = withTiming(layout.x, { duration: 0 });
        wellWidth.value = withTiming(layout.width, { duration: 0 });
      } else {
        wellX.value = withSpring(layout.x, springs.lively);
        wellWidth.value = withSpring(layout.width, springs.lively);
      }
    },
    [reduceMotion, wellX, wellWidth],
  );

  useEffect(() => {
    positionWell(activeName);
  }, [activeName, positionWell]);

  const wellStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: wellX.value }],
    width: wellWidth.value,
  }));

  const handleSlotLayout = (name: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    layouts.current[name] = { x: x + (width - TAB_SIZE) / 2, width: TAB_SIZE };
    if (name === activeName) positionWell(name);
  };

  const renderTab = (name: string) => {
    const meta = TAB_META[name];
    if (!meta) return null;
    return (
      <TabButton
        key={name}
        meta={meta}
        active={activeName === name}
        showBadge={name === "more" && unreadCount > 0}
        reduceMotion={reduceMotion}
        onPress={() => navigation.navigate(name)}
      />
    );
  };

  const slot = (name: string) => (
    <View key={name} style={{ flex: 1, alignItems: "center" }} onLayout={handleSlotLayout(name)}>
      {renderTab(name)}
    </View>
  );

  // The sliding well: absolutely positioned across the whole row so its
  // translateX lands in the same coordinate space the slots' onLayout
  // reports were measured in. `pointerEvents="none"` — it is a painted
  // indicator, not a tap target, and must not steal presses from the tabs
  // it sits behind.
  const dockWell = (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Animated.View
          testID="dock-well"
          style={[
            {
              height: WELL_HEIGHT,
              borderRadius: WELL_RADIUS,
              backgroundColor: instrument.inset,
              overflow: "hidden",
            },
            wellStyle,
          ]}
        >
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.wellShadow }} />
          <View
            testID="dock-well-dot"
            style={{
              position: "absolute",
              bottom: 4,
              alignSelf: "center",
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: instrument.accent,
              shadowColor: instrument.accent,
              shadowOpacity: 0.7,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 0 },
            }}
          />
        </Animated.View>
      </View>
    </View>
  );

  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: 6,
    minHeight: PILL_MIN_HEIGHT,
    borderRadius: PILL_CONTENT_RADIUS,
    borderWidth: 1,
    borderColor: instrument.glassBorder,
    overflow: "hidden" as const,
  };

  return (
    <View style={{ position: "absolute", left: 24, right: 24, bottom: 24 }} pointerEvents="box-none">
      <View style={{ position: "relative" }}>
        <LinearGradient
          testID="dock-rim"
          colors={[instrument.glassHighlight, "transparent", instrument.shade]}
          locations={[0, 0.3, 0.92]}
          style={{ borderRadius: PILL_RADIUS, padding: RIM_INSET }}
        >
          {reducedTransparency ? (
            // Reduce Transparency fallback (I3, same recipe as GlassPanel):
            // an opaque pill instead of a live BlurView.
            <View
              testID="tab-bar-pill"
              style={[rowStyle, { backgroundColor: REDUCED_TRANSPARENCY_FALLBACK[scheme] }]}
            >
              {dockWell}
              {ORDER_LEFT.map(slot)}
              <View style={{ flex: 1 }} />
              {ORDER_RIGHT.map(slot)}
            </View>
          ) : (
            <BlurView
              testID="tab-bar-pill-blur"
              intensity={scheme === "dark" ? 25 : 40}
              tint={scheme === "dark" ? "dark" : "light"}
              style={[rowStyle, { backgroundColor: instrument.glass }]}
            >
              {dockWell}
              {ORDER_LEFT.map(slot)}
              <View style={{ flex: 1 }} />
              {ORDER_RIGHT.map(slot)}
            </BlurView>
          )}
        </LinearGradient>
        <View
          style={{ position: "absolute", top: -CAMERA_RAISE, left: 0, right: 0, alignItems: "center" }}
          pointerEvents="box-none"
        >
          <CaptureButton />
        </View>
      </View>
    </View>
  );
}
