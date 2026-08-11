import { useEffect } from "react";
import { Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { router } from "expo-router";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
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
  const { colors, instrument, radius } = useTheme();
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
        <Text
          style={{
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: 1.4,
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
        <BlurView
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
