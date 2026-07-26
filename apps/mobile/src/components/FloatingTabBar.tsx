import { useEffect } from "react";
import { View } from "react-native";
import { BlurView } from "expo-blur";
import { router } from "expo-router";
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
          <Icon name={meta.icon} size={22} color={active ? colors.primary : colors.secondaryLabel} strokeWidth={active ? 2.5 : 2} />
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

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 22, alignItems: "center" }} pointerEvents="box-none">
      <BlurView
        intensity={40}
        tint="light"
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            padding: 7,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: colors.separator,
            overflow: "hidden",
            backgroundColor: colors.card + "AE",
          },
          shadows.lg,
        ]}
      >
        {ORDER_LEFT.map(renderTab)}
        <PressableScale
          accessibilityLabel="Capture"
          accessibilityRole="button"
          haptic="impactLight"
          onPress={() => router.push("/capture")}
          style={[
            { width: 54, height: 54, marginHorizontal: 2, borderRadius: radius.full, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
            shadows.md,
          ]}
        >
          <Icon name="camera" size={24} color={colors.primaryForeground} />
        </PressableScale>
        {ORDER_RIGHT.map(renderTab)}
      </BlurView>
    </View>
  );
}
