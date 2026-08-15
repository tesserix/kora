import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOutDown } from "react-native-reanimated";
import { AppText } from "./Text";
import { REDUCED_TRANSPARENCY_FALLBACK } from "./instrument/GlassPanel";
import { useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void; durationMs?: number };
type ToastApi = { show: (o: ToastOptions) => void };

const Ctx = createContext<ToastApi>({ show: () => {} });
export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { instrument, radius, spacing, shadows, scheme } = useTheme();
  const { reduceMotion } = useMotionPrefs();
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

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      {toast ? (
        <Animated.View
          testID="toast"
          // The app's primary confirmation surface — and the only place the
          // 5s Undo window is offered — so it has to announce itself. Without
          // this a VoiceOver user saving or deleting a meal heard nothing and
          // the Undo window expired unnoticed.
          accessibilityLiveRegion="polite"
          // Reduce Motion keeps the fade and drops the translate; reanimated
          // would otherwise degrade FadeInDown to an instant pop-in.
          entering={reduceMotion ? FadeIn.duration(150) : FadeInDown}
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
            borderRadius: radius.xl,
            backgroundColor: REDUCED_TRANSPARENCY_FALLBACK[scheme],
            borderWidth: 1,
            borderColor: instrument.glassBorder,
            ...shadows.card,
          }}
        >
          <AppText style={{ flex: 1, color: instrument.ink }}>{toast.message}</AppText>
          {toast.actionLabel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toast.actionLabel}
              onPress={() => {
                toast.onAction?.();
                dismiss();
              }}
              style={(state) => ({ marginLeft: spacing.md, opacity: state.pressed ? 0.6 : 1 })}
            >
              <AppText style={{ color: instrument.accent, fontWeight: "700" }}>{toast.actionLabel}</AppText>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  );
}
