import { useEffect } from "react";
import { Tabs, router } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { takeSessionExpiredNotice } from "@/lib/api";
import { usePushRegistration, usePushResponder } from "@/lib/push";
import { useProfile } from "@/api/hooks";
import { FloatingTabBar } from "@/components/FloatingTabBar";
import { useTheme } from "@/theme";

export default function TabsLayout() {
  const { colors } = useTheme();
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

  useEffect(() => {
    if (profile.data && profile.data.onboarded_at === null) router.replace("/onboarding");
  }, [profile.data]);

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
