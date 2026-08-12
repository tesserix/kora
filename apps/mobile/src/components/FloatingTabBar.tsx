import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { router } from "expo-router";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
import { useReducedTransparency, REDUCED_TRANSPARENCY_FALLBACK } from "./instrument/GlassPanel";
import { PressableScale, springs } from "@/motion";
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
// painted area of the active well. Radius 18 is the top of the spec's
// pills/chips band (14–18), nested inside the bar's own radius 32.
const TAB_SIZE = 52;
const TAB_WELL_RADIUS = 18;

type FloatingTabBarProps = {
  state: { index: number; routes: ReadonlyArray<{ key: string; name: string }> };
  navigation: { navigate: (name: string) => void };
};

type TabButtonProps = {
  name: string;
  meta: { icon: string; label: string };
  active: boolean;
  showBadge: boolean;
  onPress: () => void;
};

function TabButton({ name, meta, active, showBadge, onPress }: TabButtonProps) {
  const { instrument } = useTheme();
  const scale = useSharedValue(active ? 1.08 : 1);
  const well = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    scale.value = withSpring(active ? 1.08 : 1, springs.standard);
    well.value = withSpring(active ? 1 : 0, springs.standard);
  }, [active, scale, well]);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Fade, not a background-color swap: the well has to leave the tab you just
  // left as well as arrive on the one you tapped, and swapping the fill to
  // "transparent" would pop instead of spring out.
  const wellStyle = useAnimatedStyle(() => ({ opacity: well.value }));

  return (
    <PressableScale
      accessibilityLabel={meta.label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      haptic="selection"
      onPress={onPress}
      style={{ width: TAB_SIZE, height: TAB_SIZE, borderRadius: TAB_WELL_RADIUS, alignItems: "center", justifyContent: "center" }}
    >
      {/* The recessed well marking the active tab — same `inset` fill + hairline
          `glassBorder` ring SegmentedGlass gives its selected segment, so a tab
          bar and a segmented control read as one system. Deliberately NEUTRAL:
          the 4pt dot below is the bar's single accent element (spec: accent
          rules, one per view). Rendered behind the content and non-interactive
          so it cannot eat the tab's own presses. */}
      <Animated.View
        testID={active ? "tab-active-pill" : undefined}
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: TAB_WELL_RADIUS,
            backgroundColor: instrument.inset,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: instrument.glassBorder,
          },
          wellStyle,
        ]}
      />
      <View style={{ alignItems: "center", justifyContent: "center" }}>
        <Animated.View style={iconStyle}>
          <Icon name={meta.icon} size={22} color={active ? instrument.ink : instrument.mut} strokeWidth={active ? 2.5 : 2} />
        </Animated.View>
        <View
          testID={active ? "tab-dot-active" : undefined}
          style={{
            marginBottom: 6,
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: active ? instrument.accent : "transparent",
          }}
        />
        {/* At 9px an engraved label separates by weight long before it
            separates by hue, so the inactive state is demoted twice over:
            `mut` at 500 and held back to 72% opacity, against full-opacity
            `ink` at 700. */}
        <Text
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
      </View>
    </PressableScale>
  );
}

// Raised, glowing camera cap. Rendered as a SIBLING of the glass pill (not a
// child) — the pill uses overflow:"hidden" for its blur/border-radius, which
// would clip a button positioned above its top edge.
function CaptureButton() {
  const { instrument } = useTheme();

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
        backgroundColor: instrument.accent,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: instrument.accent,
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 10 },
        elevation: 10,
      }}
    >
      <Icon name="camera" size={22} color={instrument.accentOn} />
    </PressableScale>
  );
}

export function FloatingTabBar({ state, navigation }: FloatingTabBarProps) {
  const { instrument, scheme } = useTheme();
  const reduced = useReducedTransparency();
  const activeName = state.routes[state.index]?.name;
  const unread = useUnreadCount();
  const unreadCount = unread.data?.count ?? 0;

  const renderTab = (name: string) => {
    const meta = TAB_META[name];
    if (!meta) return null;
    return (
      <TabButton
        key={name}
        name={name}
        meta={meta}
        active={activeName === name}
        showBadge={name === "more" && unreadCount > 0}
        onPress={() => navigation.navigate(name)}
      />
    );
  };

  const slot = (name: string) => (
    <View key={name} style={{ flex: 1, alignItems: "center" }}>{renderTab(name)}</View>
  );

  return (
    <View style={{ position: "absolute", left: 24, right: 24, bottom: 24 }} pointerEvents="box-none">
      <View style={{ position: "relative" }}>
        {reduced ? (
          // Reduce Transparency fallback (I3, same recipe as GlassPanel):
          // an opaque pill instead of a live BlurView.
          <View
            testID="tab-bar-pill"
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 6,
              height: 64,
              borderRadius: 32,
              borderWidth: 1,
              borderColor: instrument.glassBorder,
              overflow: "hidden",
              backgroundColor: REDUCED_TRANSPARENCY_FALLBACK[scheme],
            }}
          >
            {ORDER_LEFT.map(slot)}
            <View style={{ flex: 1 }} />
            {ORDER_RIGHT.map(slot)}
          </View>
        ) : (
          <BlurView
            testID="tab-bar-pill-blur"
            intensity={scheme === "dark" ? 25 : 40}
            tint={scheme === "dark" ? "dark" : "light"}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 6,
              height: 64,
              borderRadius: 32,
              borderWidth: 1,
              borderColor: instrument.glassBorder,
              overflow: "hidden",
              backgroundColor: instrument.glass,
            }}
          >
            {ORDER_LEFT.map(slot)}
            <View style={{ flex: 1 }} />
            {ORDER_RIGHT.map(slot)}
          </BlurView>
        )}
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
