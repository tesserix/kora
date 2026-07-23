import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isFirebaseConfigured } from "@/lib/firebase";

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) {
      router.replace("/config-missing");
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }} />
    </QueryClientProvider>
  );
}
