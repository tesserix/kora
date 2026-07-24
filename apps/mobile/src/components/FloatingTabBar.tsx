import { Pressable, View } from "react-native";
import { BlurView } from "expo-blur";
import { router } from "expo-router";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

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

export function FloatingTabBar({ state, navigation }: FloatingTabBarProps) {
  const { colors, radius, shadows } = useTheme();
  const activeName = state.routes[state.index]?.name;

  const tab = (name: string) => {
    const meta = TAB_META[name];
    if (!meta) return null;
    const on = activeName === name;
    return (
      <Pressable
        key={name}
        accessibilityLabel={meta.label}
        accessibilityRole="button"
        onPress={() => navigation.navigate(name)}
        style={{ width: 52, height: 52, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.secondary : "transparent" }}
      >
        <Icon name={meta.icon} size={22} color={on ? colors.primary : colors.mutedForeground} strokeWidth={on ? 2.5 : 2} />
      </Pressable>
    );
  };

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 22, alignItems: "center" }} pointerEvents="box-none">
      <BlurView
        intensity={40}
        tint="light"
        style={[
          { flexDirection: "row", alignItems: "center", gap: 2, padding: 7, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, overflow: "hidden", backgroundColor: colors.card + "AE" },
          shadows.lg,
        ]}
      >
        {ORDER_LEFT.map(tab)}
        <Pressable
          accessibilityLabel="Capture"
          accessibilityRole="button"
          onPress={() => router.push("/log")}
          style={[{ width: 52, height: 52, marginHorizontal: 2, borderRadius: radius.full, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }, shadows.md]}
        >
          <Icon name="sparkles" size={24} color={colors.primaryForeground} />
        </Pressable>
        {ORDER_RIGHT.map(tab)}
      </BlurView>
    </View>
  );
}
