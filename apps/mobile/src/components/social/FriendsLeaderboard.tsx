import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { GroupedSection } from "@/components/GroupedList";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";
import type { FriendsProgress } from "@/api/types";

interface Props {
  data?: FriendsProgress;
}

interface Rankable {
  id: string;
  name: string;
  me: boolean;
  streak: number;
  adherence: number;
}

export function FriendsLeaderboard({ data }: Props) {
  const { colors, spacing } = useTheme();
  if (!data) return null;

  const window = data.me.adherence_window;
  // Consent gate: only friends who opted in to sharing (`sharing: true`) are
  // ranked with metrics. Non-sharers are rendered name-only below — never
  // give them a streak/adherence value, even a fallback.
  const sharing = data.friends.filter((f) => f.sharing);
  const notSharing = data.friends.filter((f) => !f.sharing);

  const ranked: Rankable[] = [
    { id: "me", name: "You", me: true, streak: data.me.streak_days, adherence: data.me.adherence_days },
    ...sharing.map((f) => ({
      id: f.id,
      name: f.display_name,
      me: false,
      streak: f.streak_days ?? 0,
      adherence: f.adherence_days ?? 0,
    })),
  ].sort((a, b) => b.streak - a.streak || b.adherence - a.adherence);

  return (
    <View style={{ gap: spacing.lg }}>
      <GroupedSection header="Leaderboard">
        {ranked.map((r, i) => (
          <View
            key={r.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: spacing.sm,
              minHeight: 44,
              paddingHorizontal: spacing.md,
              backgroundColor: r.me ? withAlpha(colors.accent, 0.08) : undefined,
            }}
          >
            <Numeral size={14} color={colors.secondaryLabel} style={{ width: 20 }}>
              {String(i + 1)}
            </Numeral>
            <View style={{ flex: 1 }}>
              <AppText variant="headline" style={r.me ? { fontWeight: "700" } : undefined}>
                {r.name}
              </AppText>
              <AppText variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
                {`${r.adherence}/${window} on target`}
              </AppText>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Numeral size={16}>{String(r.streak)}</Numeral>
              <AppText variant="footnote" muted>
                day streak
              </AppText>
            </View>
          </View>
        ))}
      </GroupedSection>

      {notSharing.length > 0 ? (
        <GroupedSection header="Not sharing">
          {notSharing.map((f) => (
            <View key={f.id} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md }}>
              <AppText variant="headline" style={{ color: colors.tertiaryLabel }}>
                {f.display_name}
              </AppText>
            </View>
          ))}
        </GroupedSection>
      ) : null}
    </View>
  );
}
