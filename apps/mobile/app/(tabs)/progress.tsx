import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

export default function Progress() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <AppText>Progress</AppText>
    </View>
  );
}
