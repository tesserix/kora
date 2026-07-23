import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { isFirebaseConfigured } from "@/lib/firebase";

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) {
      router.replace("/config-missing");
    }
  }, []);

  return <Stack screenOptions={{ headerShown: false }} />;
}
