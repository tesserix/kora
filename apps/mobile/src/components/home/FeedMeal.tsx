import { Pressable, View } from "react-native";
import { FoodTile } from "@/components/FoodTile";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { Icon } from "@/components/Icon";
import { foodVisual } from "@/lib/foodVisual";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function FeedMeal({ log, note, onOpen }: { log: FoodLog; note?: string | null; onOpen: () => void }) {
  const { colors, radius, fonts, shadows } = useTheme();
  const vis = foodVisual(log.description, log.meal_slot);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={[{ flexDirection: "row", gap: 14, alignItems: "center", padding: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.xl }, shadows.sm]}
      >
        <FoodTile hue={vis.hue} icon={vis.icon} size={60} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText muted style={{ fontFamily: fonts.mono, fontSize: 12 }}>{timeOf(log.logged_at)}</AppText>
          <AppText numberOfLines={1} style={{ fontSize: 15, fontWeight: "700" }}>{log.description}</AppText>
          <AppText muted numberOfLines={1} style={{ fontSize: 12 }}>{log.meal_slot} · {Math.round(log.quantity_grams)}g</AppText>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Numeral size={16}>{Math.round(log.kcal)}</Numeral>
          <AppText muted style={{ fontFamily: fonts.mono, fontSize: 10 }}>kcal</AppText>
        </View>
      </Pressable>
      {note ? (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", paddingLeft: 8, paddingRight: 4 }}>
          <View style={{ marginTop: 2 }}><Icon name="camera" size={14} color={colors.primary} /></View>
          <AppText muted style={{ flex: 1, fontSize: 12.5, lineHeight: 18 }}>{note}</AppText>
        </View>
      ) : null}
    </View>
  );
}
