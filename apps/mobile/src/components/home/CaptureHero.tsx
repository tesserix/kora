import { Pressable, View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { useTheme } from "@/theme";

export function CaptureHero({ onPress }: { onPress: () => void }) {
  const { colors, radius, shadows } = useTheme();
  const pill = (icon: string) => (
    <View style={{ width: 34, height: 34, borderRadius: radius.full, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={17} color={colors.primaryForeground} />
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingLeft: 18, paddingRight: 14, borderRadius: radius["2xl"], backgroundColor: colors.primary }, shadows.lg]}
    >
      <Icon name="camera" size={22} color={colors.primaryForeground} />
      <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.primaryForeground }}>Snap a meal or tell Otto what you ate…</AppText>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {pill("camera")}
        {pill("mic")}
      </View>
    </Pressable>
  );
}
