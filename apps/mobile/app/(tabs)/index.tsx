import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

export default function Home() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <AppText>Home</AppText>
    </View>
  );
}
