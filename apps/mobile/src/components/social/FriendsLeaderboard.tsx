import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Numeral } from "@/components/Numeral";
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
  const { colors, radius } = useTheme();
  if (!data) return null;

  const window = data.me.adherence_window;
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
    <View style={{ gap: 10 }}>
      <Overline>Leaderboard</Overline>
      {ranked.map((r, i) => (
        <View
          key={r.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            padding: 14,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: r.me ? colors.primary : colors.border,
            backgroundColor: colors.card,
          }}
        >
          <Numeral size={14} color={colors.mutedForeground}>{String(i + 1)}</Numeral>
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 15, fontWeight: r.me ? "700" : "600" }}>{r.name}</AppText>
            <AppText muted style={{ fontSize: 12 }}>{`${r.adherence}/${window} on target`}</AppText>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Numeral size={16}>{String(r.streak)}</Numeral>
            <AppText muted style={{ fontSize: 11 }}>day streak</AppText>
          </View>
        </View>
      ))}

      {notSharing.length > 0 ? (
        <View style={{ gap: 8, marginTop: 6 }}>
          <Overline>Not sharing</Overline>
          {notSharing.map((f) => (
            <AppText key={f.id} muted style={{ fontSize: 14, paddingHorizontal: 4 }}>{f.display_name}</AppText>
          ))}
        </View>
      ) : null}
    </View>
  );
}
