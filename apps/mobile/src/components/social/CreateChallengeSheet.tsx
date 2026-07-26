import { useState } from "react";
import { TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { useCreateChallenge } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { Metric } from "@/api/types";

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
  const { colors, radius, spacing } = useTheme();
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState<Metric>("on_target");
  const [duration, setDuration] = useState("1w");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateChallenge();

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
        onSuccess: (c: { id: string }) => {
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
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.md }}>
        <Overline>New challenge</Overline>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoCapitalize="sentences"
          placeholder="Challenge title"
          placeholderTextColor={colors.secondaryLabel}
          accessibilityLabel="Challenge title"
          style={{
            fontSize: 16,
            color: colors.label,
            backgroundColor: colors.cardSecondary,
            borderRadius: radius.lg,
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        />

        <View style={{ gap: spacing.xs }}>
          <Overline>Metric</Overline>
          <Segmented options={METRICS} value={metric} onChange={(key) => setMetric(key as Metric)} />
        </View>

        <View style={{ gap: spacing.xs }}>
          <Overline>Duration</Overline>
          <Segmented options={DURATIONS} value={duration} onChange={setDuration} />
        </View>

        {err ? <AppText style={{ color: colors.destructive }}>{err}</AppText> : null}
        <Button title="Create challenge" onPress={onSubmit} disabled={create.isPending} />
      </View>
    </Sheet>
  );
}
