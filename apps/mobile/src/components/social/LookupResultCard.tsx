import { View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useTheme } from "@/theme";
import type { LookupResult } from "@/api/types";

// initials() mirrors app/profile.tsx's fallback so one person renders the same
// letters everywhere they appear without a picture.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

type Props = { result: LookupResult; onSend: () => void; sending: boolean };

// This is the screen the avatar exists for: the last surface before a request
// that may end in sharing body metrics. It renders ONLY a resolved result —
// the caller must not mount it while a lookup is pending, because a name shown
// mid-flight is a factual claim about someone made from state that is not an
// answer yet (kora#443).
export function LookupResultCard({ result, onSend, sending }: Props) {
  const { instrument, radius } = useTheme();
  // A display name can be blank. "@ada" is a true statement about this person;
  // an empty line above "Send request" is not.
  const name = result.display_name.trim() || "@" + result.handle;

  return (
    <View
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: radius.lg,
        backgroundColor: instrument.inset,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
      }}
    >
      <Avatar initials={initials(result.display_name) || "@"} size={48} uri={result.avatar_url} />
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink }}>{name}</AppText>
        {result.display_name.trim() ? (
          <AppText style={{ fontSize: 14, color: instrument.mut, marginTop: 2 }}>
            @{result.handle}
          </AppText>
        ) : null}
      </View>
      <Button title="Send request" onPress={onSend} disabled={sending} />
    </View>
  );
}
