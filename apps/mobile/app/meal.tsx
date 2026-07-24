import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { FoodTile } from "@/components/FoodTile";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { foodVisual } from "@/lib/foodVisual";
import { tileFaint, MACRO } from "@/lib/hue";
import { useTheme } from "@/theme";

export default function MealDetail() {
  const { colors, radius, fonts } = useTheme();
  const p = useLocalSearchParams<{ name: string; mealSlot: string; time: string; kcal: string; protein: string; carbs: string; fat: string }>();
  const name = p.name ?? "Meal";
  const vis = foodVisual(name, p.mealSlot);
  const tiles: ReadonlyArray<readonly [string, string, number]> = [
    ["Protein", `${p.protein ?? 0}g`, MACRO.protein.hue],
    ["Carbs", `${p.carbs ?? 0}g`, MACRO.carbs.hue],
    ["Fat", `${p.fat ?? 0}g`, MACRO.fat.hue],
  ];
  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1 }}>
            <Overline>{name} · {p.time}</Overline>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
              <Numeral size={24}>{p.kcal}</Numeral>
              <AppText muted style={{ fontFamily: fonts.mono, fontSize: 14 }}>kcal</AppText>
            </View>
          </View>
          <Badge variant="success" icon="sparkles">AI logged</Badge>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginBottom: 18 }}>
          {tiles.map(([label, value, hue]) => (
            <View key={label} style={{ flex: 1, backgroundColor: tileFaint(hue), borderRadius: radius.lg, padding: 12 }}>
              <AppText muted style={{ fontSize: 11, fontWeight: "600" }}>{label}</AppText>
              <Numeral size={16} color={`hsl(${hue}, 55%, 38%)`}>{value}</Numeral>
            </View>
          ))}
        </View>

        <Overline>Items</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 8, marginBottom: 20 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={40} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 14, fontWeight: "600" }}>{name}</AppText>
            <AppText muted style={{ fontFamily: fonts.mono, fontSize: 12 }}>{p.kcal} kcal</AppText>
          </View>
        </View>

        <Button title="Done" onPress={() => router.back()} />
      </View>
    </Sheet>
  );
}
