import { Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { safeBack } from "@/lib/safeBack";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

const OFF_URL = "https://world.openfoodfacts.org";
const AFCD_URL = "https://www.foodstandards.gov.au/science-data/food-nutrient-databases/afcd";
const USDA_URL = "https://fdc.nal.usda.gov";

interface Source {
  name: string;
  detail: string;
  licence: string;
  url: string;
}

// Source licences require attribution in the app where their figures are used.
const SOURCES: ReadonlyArray<Source> = [
  {
    name: "Australian Food Composition Database",
    detail:
      "Food Standards Australia New Zealand (FSANZ), Release 3. Laboratory-measured nutrients for foods sold in Australia.",
    licence: "© FSANZ",
    url: AFCD_URL,
  },
  {
    name: "AUSNUT 2023",
    detail: "FSANZ survey data for Australian foods as consumed, including prepared meals and takeaway foods.",
    licence: "© FSANZ",
    url: "https://www.foodstandards.gov.au/science-data/food-nutrient-databases/ausnut",
  },
  {
    name: "Indian Food Composition Tables 2017",
    detail: "National Institute of Nutrition, Hyderabad. Ingredient measurements from the MIT-licensed IFCT transcription, version 2.0.5.",
    licence: "MIT transcription · IFCT 2017",
    url: "https://github.com/ifct2017/compositions/tree/2.0.5",
  },
  {
    name: "Open Food Facts",
    detail:
      "Community-maintained barcode data for packaged products. Contributed by volunteers, so figures can vary from the packet.",
    licence: "Open Database License (ODbL)",
    url: OFF_URL,
  },
  {
    name: "USDA FoodData Central",
    detail: "SR Legacy reference data and FNDDS survey foods from the United States Department of Agriculture.",
    licence: "Public domain",
    url: USDA_URL,
  },
  {
    name: "UK Composition of Foods Integrated Dataset",
    detail: "CoFID 2021, Public Health England. UK food composition data, adapted for Kora. Contains public sector information licensed under the Open Government Licence v3.0.",
    licence: "Open Government Licence v3.0",
    url: "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid",
  },
  {
    name: "Standard Tables of Food Composition in Japan",
    detail: "Ministry of Education, Culture, Sports, Science and Technology (MEXT). English 2015 edition, adapted for Kora; estimated source values remain estimates.",
    licence: "MEXT Public Data License · CC BY 4.0 compatible",
    url: "https://www.mext.go.jp/en/policy/science_technology/policy/title01/detail01/sdetail01/sdetail01/1385122.htm",
  },
];

export default function AboutScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const version = Constants.expoConfig?.version ?? "";

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      >
        <ScreenHeader overline="Kora" title="About" onBack={() => safeBack("/(tabs)/more")} />

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.md }}>
          <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 19 }}>
            Nutrition figures in Kora come from the public food databases below. Kora never invents a
            calorie figure — every number is read from one of these sources.
          </AppText>
          <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 19 }}>
            Recipe-based foods use ingredient weights and cooked yields to estimate nutrition.
            Ingredients, preparation and product labels can change these figures.
          </AppText>

          {SOURCES.map((source) => (
            <GlassPanel key={source.name} radius={18}>
              <PressableScale
                accessibilityRole="link"
                accessibilityLabel={`${source.name}, opens in your browser`}
                haptic="selection"
                onPress={() => void Linking.openURL(source.url)}
                style={{ padding: spacing.md, gap: 6 }}
              >
                <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
                  {source.name}
                </AppText>
                <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 18 }}>
                  {source.detail}
                </AppText>
                <AppText
                  style={{
                    fontSize: 11,
                    fontWeight: "700",
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: instrument.mut,
                  }}
                >
                  {source.licence}
                </AppText>
              </PressableScale>
            </GlassPanel>
          ))}

          {version ? (
            <AppText style={{ fontSize: 12, color: instrument.mut, textAlign: "center" }}>
              {`Version ${version}`}
            </AppText>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
