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

// Kora's nutrition figures come from three public datasets, and one of them
// obliges us to say so.
//
// OpenFoodFacts is published under the Open Database License. ODbL requires
// attribution wherever the data is used — that is not optional and not
// satisfied by a line in a repo, so it lives here, in the app, where the person
// reading a calorie figure can see where it came from (kora#197).
//
// The other two are listed alongside it deliberately. Naming only the one with
// a licence obligation would read as legal boilerplate; naming all three makes
// this a statement about provenance, which is the more useful thing for a user
// deciding how much to trust a number. It also matters that they are visibly
// DIFFERENT: an FSANZ laboratory measurement and a community-entered barcode
// row are not equally authoritative, and the descriptions say so.
const SOURCES: ReadonlyArray<Source> = [
  {
    name: "Australian Food Composition Database",
    detail:
      "Food Standards Australia New Zealand (FSANZ), Release 3. Laboratory-measured nutrients for foods sold in Australia.",
    licence: "© FSANZ",
    url: AFCD_URL,
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
    detail: "SR Legacy reference data from the United States Department of Agriculture.",
    licence: "Public domain",
    url: USDA_URL,
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
