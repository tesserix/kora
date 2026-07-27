import { useEffect, useId } from "react";
import { View } from "react-native";
import { BlurView } from "expo-blur";
import { router } from "expo-router";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
import { PressableScale, springs } from "@/motion";
import { useUnreadCount } from "@/api/hooks";

const TAB_META: Record<string, { icon: string; label: string }> = {
  index: { icon: "house", label: "Home" },
  diary: { icon: "book-open", label: "Diary" },
  progress: { icon: "chart-line", label: "Progress" },
  more: { icon: "grid-2x2", label: "More" },
};

const ORDER_LEFT = ["index", "diary"];
const ORDER_RIGHT = ["progress", "more"];

// Camera cap is raised above the pill (see CaptureButton). The pill spans the
// full width (20px side insets, like the mock) with the tabs in equal flex
// slots and a flex slot in the middle reserved for the raised camera.
const CAMERA_SIZE = 58;
const CAMERA_RAISE = 18;
// Width of the background-colored "seat" ring around the camera. It's the page
// background color, so it's invisible against the page above the dock (the raised
// top stays clean) and only reads as a thin gap where the button sinks into the
// dock. Kept thin so the green — not the ring — stays dominant.
const CAMERA_RING = 2;

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
  const { colors, radius } = useTheme();
  const scale = useSharedValue(active ? 1.08 : 1);

  useEffect(() => {
    scale.value = withSpring(active ? 1.08 : 1, springs.standard);
  }, [active, scale]);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <PressableScale
      accessibilityLabel={meta.label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      haptic="selection"
      onPress={onPress}
      style={{ width: 52, height: 52, borderRadius: radius.full, alignItems: "center", justifyContent: "center" }}
    >
      <View style={{ alignItems: "center", justifyContent: "center" }}>
        <Animated.View style={iconStyle}>
          <Icon name={meta.icon} size={24} color={active ? colors.primary : colors.secondaryLabel} strokeWidth={active ? 2.5 : 2} />
        </Animated.View>
        {active ? (
          <View testID={`${name}-active-dot`} style={{ marginTop: 3, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary }} />
        ) : (
          <View style={{ marginTop: 3, width: 4, height: 4 }} />
        )}
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
              backgroundColor: colors.primary,
              borderWidth: 1.5,
              borderColor: colors.card,
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
  const { colors, gradients } = useTheme();
  const gradientId = useId();
  const half = CAMERA_SIZE / 2;
  const outer = CAMERA_SIZE + CAMERA_RING * 2;

  return (
    <PressableScale
      accessibilityLabel="Capture"
      accessibilityRole="button"
      haptic="impactLight"
      onPress={() => router.push("/capture")}
      style={{
        width: outer,
        height: outer,
        borderRadius: outer / 2,
        backgroundColor: colors.background,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: colors.accent,
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 10 },
        elevation: 10,
      }}
    >
      <Svg width={CAMERA_SIZE} height={CAMERA_SIZE}>
        <Defs>
          <LinearGradient id={gradientId} x1="0.2" y1="0" x2="0.8" y2="1">
            <Stop offset="0%" stopColor={gradients.green[0]} />
            <Stop offset="100%" stopColor={gradients.green[1]} />
          </LinearGradient>
        </Defs>
        <Circle cx={half} cy={half} r={half} fill={`url(#${gradientId})`} />
      </Svg>
      <View
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}
        pointerEvents="none"
      >
        <Icon name="camera" size={26} color={colors.primaryForeground} />
      </View>
    </PressableScale>
  );
}

export function FloatingTabBar({ state, navigation }: FloatingTabBarProps) {
  const { colors, radius, shadows } = useTheme();
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
    <View style={{ position: "absolute", left: 20, right: 20, bottom: 22 }} pointerEvents="box-none">
      <View style={{ position: "relative" }}>
        <BlurView
          intensity={40}
          tint="dark"
          style={[
            {
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 8,
              paddingHorizontal: 6,
              borderRadius: radius["2xl"],
              borderWidth: 1,
              borderColor: colors.separator,
              overflow: "hidden",
              backgroundColor: colors.card + "C0",
            },
            shadows.lg,
          ]}
        >
          {ORDER_LEFT.map(slot)}
          <View style={{ flex: 1 }} />
          {ORDER_RIGHT.map(slot)}
        </BlurView>
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
