import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isFirebaseConfigured } from "@/lib/firebase";

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) router.replace("/config-missing");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="meal" options={{ presentation: "transparentModal", animation: "fade" }} />
        <Stack.Screen name="capture" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
      </Stack>
    </QueryClientProvider>
  );
}
