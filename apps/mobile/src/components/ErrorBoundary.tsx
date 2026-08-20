import { Component, type ErrorInfo, type ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { PressableScale } from "@/motion";
import { reportError } from "@/observability/reporter";
import { useTheme } from "@/theme";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Split out because useTheme is a hook and cannot be called in the class that
// owns componentDidCatch.
function ErrorFallback({ onReset }: { onReset: () => void }) {
  const { instrument, spacing } = useTheme();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: instrument.bg,
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.lg,
      }}
    >
      <GlassPanel radius={22} style={{ padding: spacing.lg, gap: spacing.sm, alignItems: "center" }}>
        <AppText variant="headline" style={{ color: instrument.ink }}>
          Something went wrong.
        </AppText>
        <AppText style={{ fontSize: 14, color: instrument.mut, textAlign: "center" }}>
          Kora hit an unexpected problem. Your logged meals are safe.
        </AppText>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Try again"
          haptic="none"
          onPress={onReset}
          style={{
            marginTop: spacing.sm,
            minHeight: 44,
            paddingHorizontal: spacing.lg,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: instrument.inset,
          }}
        >
          <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
            Try again
          </AppText>
        </PressableScale>
      </GlassPanel>
    </View>
  );
}

/**
 * Catches render errors, reports them, and shows a recoverable screen.
 *
 * Without this a render error leaves a blank screen and ends the session —
 * for a beta tester, indistinguishable from the app being dead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is React's own string and can name user-authored
    // content in props, so it is deliberately NOT forwarded — only the error.
    void info;
    reportError(error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onReset={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}
