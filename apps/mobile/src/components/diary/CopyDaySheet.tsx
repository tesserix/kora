import { useState } from "react";
import { Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCopyDay } from "@/api/hooks";
import { useTheme } from "@/theme";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d: Date) => d.toLocaleDateString("en-CA");

interface CopyDaySheetProps {
  visible: boolean;
  targetDate: string;
  onClose: () => void;
}

// The seven most recent days ending today, minus the target day itself.
function recentDays(targetDate: string): Date[] {
  const today = new Date();
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    if (iso(d) !== targetDate) days.push(d);
  }
  return days;
}

export function CopyDaySheet({ visible, targetDate, onClose }: CopyDaySheetProps) {
  const { colors, radius } = useTheme();
  const [msg, setMsg] = useState<string | null>(null);
  const copyDay = useCopyDay();
  const days = recentDays(targetDate);

  const onPick = (from: string) => {
    setMsg(null);
    copyDay.mutate(
      { from, to: targetDate },
      {
        onSuccess: (res) => {
          if (res.copied > 0) onClose();
          else setMsg("That day had nothing to copy.");
        },
        onError: () => setMsg("Couldn't copy. Try again."),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Copy a day</Overline>
        <AppText muted style={{ fontSize: 12, marginTop: 6, marginBottom: 16 }}>
          Pick a day to copy into {targetDate}.
        </AppText>
        <View style={{ gap: 8 }}>
          {days.map((d) => {
            const dISO = iso(d);
            return (
              <Pressable
                key={dISO}
                accessibilityRole="button"
                accessibilityLabel={`Copy from ${dISO}`}
                disabled={copyDay.isPending}
                onPress={() => onPick(dISO)}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, opacity: copyDay.isPending ? 0.5 : 1 }}
              >
                <AppText style={{ fontSize: 15, fontWeight: "600" }}>{DOW[d.getDay()]}</AppText>
                <AppText muted style={{ fontSize: 13 }}>{dISO}</AppText>
              </Pressable>
            );
          })}
        </View>
        {msg ? <AppText style={{ color: colors.destructive, marginTop: 14 }}>{msg}</AppText> : null}
      </View>
    </Sheet>
  );
}
