import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCreateChallenge } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { ChallengeSummary, Metric } from "@/api/types";

interface Props {
  visible: boolean;
  groupId: string;
  onClose: () => void;
}

const METRICS: { key: Metric; label: string }[] = [
  { key: "on_target", label: "On-target days" },
  { key: "logged", label: "Logged days" },
];
const DURATIONS: { key: string; label: string }[] = [
  { key: "1w", label: "1 week" },
  { key: "2w", label: "2 weeks" },
  { key: "1mo", label: "1 month" },
];

export function CreateChallengeSheet({ visible, groupId, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState<Metric>("on_target");
  const [duration, setDuration] = useState("1w");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateChallenge();

  const pill = (selected: boolean) => ({
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: selected ? colors.primary : colors.border,
    backgroundColor: selected ? colors.primary : "transparent",
  });

  const onSubmit = () => {
    const v = title.trim();
    if (!v) {
      setErr("Name your challenge.");
      return;
    }
    setErr(null);
    create.mutate(
      { groupId, title: v, metric, duration },
      {
        onSuccess: (c: ChallengeSummary) => {
          setTitle("");
          onClose();
          router.push(`/challenge/${c.id}` as Href);
        },
        onError: () => setErr("Couldn't create. Try again."),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: 14 }}>
        <Overline>New challenge</Overline>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoCapitalize="sentences"
          placeholder="Challenge title"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Challenge title"
          style={{ fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />

        <View style={{ gap: 8 }}>
          <Overline>Metric</Overline>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {METRICS.map((m) => (
              <Pressable key={m.key} accessibilityRole="button" onPress={() => setMetric(m.key)} style={pill(metric === m.key)}>
                <AppText style={{ color: metric === m.key ? colors.primaryForeground : colors.foreground, fontSize: 13 }}>{m.label}</AppText>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Overline>Duration</Overline>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {DURATIONS.map((dn) => (
              <Pressable key={dn.key} accessibilityRole="button" onPress={() => setDuration(dn.key)} style={pill(duration === dn.key)}>
                <AppText style={{ color: duration === dn.key ? colors.primaryForeground : colors.foreground, fontSize: 13 }}>{dn.label}</AppText>
              </Pressable>
            ))}
          </View>
        </View>

        {err ? <AppText style={{ color: colors.destructive }}>{err}</AppText> : null}
        <Button title="Create challenge" onPress={onSubmit} disabled={create.isPending} />
      </View>
    </Sheet>
  );
}
