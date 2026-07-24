import { Pressable, ScrollView, View } from "react-native";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { useTheme } from "@/theme";

const ROWS = [
  { icon: "message-circle", label: "Coach" },
  { icon: "trending-up", label: "Insights" },
  { icon: "grid-2x2", label: "Add-ons" },
];

export default function More() {
  const { colors, spacing } = useTheme();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Your account" title="More" />
      <View style={{ paddingHorizontal: 20, gap: spacing.sm }}>
        {ROWS.map((r) => (
          <View key={r.label} style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
            <Icon name={r.icon} size={20} color={colors.primary} />
            <AppText style={{ fontSize: 15, fontWeight: "600" }}>{r.label}</AppText>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => auth && signOut(auth)}
          style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: spacing.md, marginTop: spacing.md }}
        >
          <AppText style={{ color: colors.destructive, fontWeight: "600" }}>Sign out</AppText>
        </Pressable>
      </View>
    </ScrollView>
  );
}
