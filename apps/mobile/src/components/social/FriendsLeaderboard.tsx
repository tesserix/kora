import { View } from "react-native";
import { AppText } from "@/components/Text";
import { LeaderRow } from "@/components/LeaderRow";
import { GroupedSection } from "@/components/GroupedList";
import { useTheme } from "@/theme";
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
      <GroupedSection header="Leaderboard" elevated>
        {ranked.map((r, i) => (
          <LeaderRow
            key={r.id}
            rank={i + 1}
            name={r.name}
            sub={`${r.adherence}/${window} on target`}
            metric={`${r.streak}d`}
            isYou={r.me}
          />
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
