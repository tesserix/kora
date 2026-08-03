import { Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useTheme } from "@/theme";

interface QueuedFailedSheetProps {
  visible: boolean;
  description: string;
  onRetry: () => void;
  onDiscard: () => void;
  onClose: () => void;
}

// The only escape hatch for a queued log the server permanently refused (a
// 4xx — see isPermanent in src/offline/queue.ts). Nothing else will ever send
// it, so without this the row would sit in the diary forever.
export function QueuedFailedSheet({ visible, description, onRetry, onDiscard, onClose }: QueuedFailedSheetProps) {
  const { colors, radius } = useTheme();

  const option = (label: string, detail: string, destructive: boolean, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
    >
      <AppText style={{ fontSize: 15, fontWeight: "600", color: destructive ? colors.destructive : colors.label }}>{label}</AppText>
      <AppText muted style={{ fontSize: 13, marginTop: 2 }}>{detail}</AppText>
    </Pressable>
  );

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>This log didn&apos;t sync</Overline>
        <AppText muted style={{ fontSize: 12, marginTop: 6, marginBottom: 16 }}>
          {description} is still on this device only.
        </AppText>
        <View style={{ gap: 8 }}>
          {option("Retry", "Send it again the next time you're online.", false, onRetry)}
          {option("Discard", "Remove it from your diary for good.", true, onDiscard)}
        </View>
      </View>
    </Sheet>
  );
}
