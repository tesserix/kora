import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCopyDay } from "@/api/hooks";
import { useToast } from "@/components/Toast";
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
  const toast = useToast();
  const days = recentDays(targetDate);

  const runCopy = (from: string) => {
    setMsg(null);
    copyDay.mutate(
      { from, to: targetDate },
      {
        onSuccess: (res) => {
          if (res.copied > 0) {
            // #174: the write was silent in both directions — no confirm going
            // in, no report coming out. The server returns a count and nothing
            // else (no ids), so an Undo can't be offered honestly; the least we
            // owe the user is to say what landed in their diary.
            toast.show({ message: `Copied ${res.copied} ${res.copied === 1 ? "entry" : "entries"} to ${targetDate}.` });
            onClose();
          } else setMsg("That day had nothing to copy.");
        },
        onError: () => setMsg("Couldn't copy. Try again."),
      },
    );
  };

  // #174: one tap used to write a whole day into the diary. The source day's
  // entry count isn't known here — it lives on the server and is only reported
  // back in the response — so the confirm names the scope rather than a number
  // it would have to invent.
  const onPick = (from: string) =>
    Alert.alert(
      `Copy ${from} into ${targetDate}?`,
      "Every entry logged that day is added to your diary. Undoing it means deleting each entry.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Copy", onPress: () => runCopy(from) },
      ],
    );

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
                // Stays a raw Pressable rather than a PressableScale: the row
                // already owns its own opacity (dimmed while a copy is in
                // flight), and the pressed state folds into the same value.
                style={(state) => ({ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, opacity: copyDay.isPending ? 0.5 : state.pressed ? 0.6 : 1 })}
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
