import { useEffect } from "react";
import { View } from "react-native";
import { Tabs, router } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { ApiError, takeSessionExpiredNotice } from "@/lib/api";
import { usePushRegistration, usePushResponder } from "@/lib/push";
import { useProfile } from "@/api/hooks";
import { FloatingTabBar } from "@/components/FloatingTabBar";
import { BrandMark } from "@/components/BrandMark";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useTheme } from "@/theme";

export default function TabsLayout() {
  const { colors, spacing } = useTheme();
  const profile = useProfile();
  usePushRegistration();
  usePushResponder();

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) return;
      // A forced sign-out (api.ts, after a 401 survives a token refresh)
      // sets this notice right before calling signOut — this is the same
      // redirect a manual sign-out takes, just with a reason attached so
      // sign-in.tsx can explain why the user landed back here.
      router.replace(
        takeSessionExpiredNotice()
          ? { pathname: "/sign-in", params: { reason: "expired" } }
          : "/sign-in",
      );
    });
    return unsub;
  }, []);

  // Resolved BEFORE <Tabs> renders. The old code redirected from an effect that
  // fired only once profile.data existed, which produced two defects: a flash
  // of empty app while GET /v1/me was in flight, and — if the request failed —
  // a user sitting in an empty tabs shell with no onboarding and no way out.
  // #108 widened that hole: one tap now creates an account.
  //
  // TabsLayout is the right chokepoint because every entry path crosses it —
  // fresh sign-in AND cold start with an existing session. Routing from
  // sign-in.tsx instead would miss relaunches entirely.
  //
  // isPending, not isLoading: react-query leaves queries on the default
  // networkMode "online" (src/lib/queryClient.ts), so with no connectivity
  // on a cold start the profile query is status "pending" with fetchStatus
  // "paused" — isPending is true but isLoading is false. Gating on isLoading
  // alone let that state fall through to <Tabs> with no data, which is the
  // exact empty-shell stranding this task exists to eliminate. isPending is
  // false once data is cached, so a background refetch still renders <Tabs>.
  if (profile.isPending) return <Splash />;

  if (profile.isError) {
    // A 401 means api.ts already forced a sign-out and the onAuthStateChanged
    // effect above is redirecting to /sign-in?reason=expired. Offering "Retry"
    // here would be misleadingly actionable: the session is gone.
    //
    // Discriminated on status, NOT on takeSessionExpiredNotice() — that is a
    // one-shot the sign-out effect consumes to attach `reason=expired`, and
    // reading it here would silently drop the explanation.
    if (profile.error instanceof ApiError && profile.error.status === 401) return <Splash />;

    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
        }}
      >
        <BrandMark size={48} />
        <AppText variant="title2">Couldn&apos;t load your profile</AppText>
        <AppText muted style={{ textAlign: "center" }}>
          Check your connection and try again.
        </AppText>
        <Button
          accessibilityLabel="Retry"
          title="Retry"
          onPress={() => {
            void profile.refetch();
          }}
        />
      </View>
    );
  }

  if (profile.data && profile.data.onboarded_at === null) {
    router.replace("/onboarding");
    return <Splash />;
  }

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="diary" />
      <Tabs.Screen name="progress" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}

// Not a spinner over an empty app: the app genuinely has not started yet, and
// the splash says so honestly.
function Splash() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <BrandMark size={64} />
    </View>
  );
}
