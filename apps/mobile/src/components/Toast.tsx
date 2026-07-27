import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Pressable } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void; durationMs?: number };
type ToastApi = { show: (o: ToastOptions) => void };

const Ctx = createContext<ToastApi>({ show: () => {} });
export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors, radius, spacing, shadows } = useTheme();
  const [toast, setToast] = useState<ToastOptions | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback((o: ToastOptions) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(o);
    timer.current = setTimeout(() => setToast(null), o.durationMs ?? 5000);
  }, []);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      {toast ? (
        <Animated.View
          entering={FadeInDown}
          exiting={FadeOutDown}
          style={{
            position: "absolute",
            left: 20,
            right: 20,
            bottom: 96,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: radius.lg,
            backgroundColor: colors.elevated,
            ...shadows.card,
          }}
        >
          <AppText style={{ flex: 1 }}>{toast.message}</AppText>
          {toast.actionLabel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toast.actionLabel}
              onPress={() => {
                toast.onAction?.();
                dismiss();
              }}
              style={{ marginLeft: spacing.md }}
            >
              <AppText style={{ color: colors.accent, fontWeight: "700" }}>{toast.actionLabel}</AppText>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  );
}
