import { Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { STORE_URL } from "@/lib/appConfig";
import { useTheme } from "@/theme";

// A deliberate dead end, like config-missing: app/_layout.tsx replaces to here
// when kora-api reports this build is older than it serves (GET
// /v1/app-config). There is nothing behind it worth reaching, because a build
// below the floor is one whose sign-in or API contract no longer works, hence
// no back button.
export default function UpdateRequired() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      >
        <ScreenHeader overline="Update" title="This version of Kora is out of date" />

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.md }}>
          <GlassPanel radius={18}>
            <View style={{ padding: spacing.md, gap: 8 }}>
              <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
                Update to keep going
              </AppText>
              <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 19 }}>
                Kora has changed in a way this version can no longer work with. Your diary is safe
                on the server and will be there when you sign in to the new version.
              </AppText>
            </View>
          </GlassPanel>

          <Button
            accessibilityLabel="Update Kora"
            title="Update Kora"
            icon="arrow-right"
            iconPosition="trailing"
            onPress={() => void Linking.openURL(STORE_URL).catch(() => {})}
          />
        </View>
      </ScrollView>
    </View>
  );
}
