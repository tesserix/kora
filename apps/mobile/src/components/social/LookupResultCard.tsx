import { View } from "react-native";
import { router, type Href } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { initials } from "@/lib/initials";
import { useTheme } from "@/theme";
import type { LookupResult } from "@/api/types";

type Props = { result: LookupResult; onSend: () => void; sending: boolean };

// A plain status line for the three non-actionable states (kora#453). A
// disabled Button here would be worse than this, not better: VoiceOver
// announces a disabled Button as "<title>. Button. Dimmed." -- a control that
// invites a tap and then refuses it -- where a plain line of text is read
// once, as the fact it is, and never implies a press is coming.
function StatusLine({ text, accessibilityLabel }: { text: string; accessibilityLabel: string }) {
  const { instrument } = useTheme();
  return (
    <AppText
      accessibilityLabel={accessibilityLabel}
      style={{ fontSize: 14, fontWeight: "600", color: instrument.mut }}
    >
      {text}
    </AppText>
  );
}

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
      {/* kora#453: only "none" and "request_received" are actionable. The
          other three states must never offer a live "Send request" -- see
          FriendshipStatus's doc comment in src/api/types.ts for what each
          value means and why. */}
      {result.friendship_status === "request_sent" ? (
        <StatusLine text="Requested" accessibilityLabel={`Friend request already sent to ${name}`} />
      ) : result.friendship_status === "friends" ? (
        <StatusLine text="Already friends" accessibilityLabel={`You and ${name} are already friends`} />
      ) : result.friendship_status === "self" ? (
        // Neither a send button (you cannot friend yourself) nor a blank
        // slot (which would look like the row failed to render) reads right
        // here -- this is the one state Lookup can name with total
        // confidence, so it gets an equally confident line of its own.
        <StatusLine text="This is you" accessibilityLabel="This is you" />
      ) : result.friendship_status === "request_received" ? (
        // They already sent THE VIEWER a request. Routed to the requests
        // list rather than wired to `onSend`: LookupView carries no friend
        // request id (only the looked-up user's id), so there is nothing
        // here to call useAcceptRequest with directly -- SendRequest would
        // technically accept the reverse-pending request, but a card that
        // says "Respond" and then silently performs a "Send" is its own
        // wrong-looking state. Sending the person to the dedicated requests
        // screen (app/friends.tsx), which already renders Accept/Decline
        // per-request, is both the honest action and the only one
        // LookupView's projection supports.
        <Button
          title="Respond"
          accessibilityLabel={`Respond to friend request from ${name}`}
          onPress={() => router.push("/friends" as Href)}
        />
      ) : (
        // "none" (and any value degraded to it, e.g. no provider wired --
        // FriendshipStatus's doc comment).
        // kora#449 task 15 finding 6: with no accessibilityLabel override,
        // VoiceOver announced only "Send request. Button." -- not naming who
        // the request is for. `name` already carries the @handle fallback for
        // a blank display_name (kora#443), so the label never goes blank
        // either.
        <Button title="Send request" accessibilityLabel={`Send request to ${name}`} onPress={onSend} disabled={sending} />
      )}
    </View>
  );
}
