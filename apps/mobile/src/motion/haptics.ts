import * as Haptics from "expo-haptics";

function safe(run: () => Promise<void>): void {
  run().catch(() => {}); // haptics are best-effort; never throw into UI
}

export const haptics = {
  selection: (): void => safe(() => Haptics.selectionAsync()),
  impactLight: (): void => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: (): void => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: (): void => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
} as const;
