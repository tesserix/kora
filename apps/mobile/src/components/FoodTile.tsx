import { View } from "react-native";
import { Icon } from "./Icon";
import { tileBg, tileFg } from "@/lib/hue";
import { useTheme } from "@/theme";

type Props = { hue?: number; icon?: string; size?: number; radius?: number };

export function FoodTile({ hue = 150, icon = "utensils", size = 56, radius }: Props) {
  const { radius: r } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? r.lg,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tileBg(hue),
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.42)} color={tileFg(hue)} />
    </View>
  );
}
