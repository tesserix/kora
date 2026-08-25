import { useState } from "react";
import { Share, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { LookupResultCard } from "./LookupResultCard";
import { useSendFriendRequest, useMyFriendCode, useLookupHandle } from "@/api/hooks";
import { useTheme } from "@/theme";
import { ApiError } from "@/lib/api";
import type { LookupResult } from "@/api/types";

interface AddFriendSheetProps {
  visible: boolean;
  onClose: () => void;
}

// A friend code is always 8 characters drawn from Crockford base32 with no
// I/L/O/U (see api/internal/social/service.go's generateCode) -- a shape a
// handle a person actually picked for themselves won't collide with. Used
// only to decide whether a lookup 404 is worth retrying as a code (below);
// it never skips the lookup, so a handle that happens to be 8 chars still
// looks itself up first.
const FRIEND_CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function AddFriendSheet({ visible, onClose }: AddFriendSheetProps) {
  const { instrument, radius } = useTheme();
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // The resolved lookup, or null. null is not just the initial state -- it is
  // also what "no confirmed answer right now" means, so every place state
  // could go stale (a fresh submit, a resend) sets it back to null first.
  const [found, setFound] = useState<LookupResult | null>(null);
  // Tracked locally rather than read off lookup.isPending: the sheet must
  // know "in flight" the instant onSubmit calls mutate, before React Query's
  // own isPending has a chance to propagate back through a render.
  const [pending, setPending] = useState(false);
  const send = useSendFriendRequest();
  const lookup = useLookupHandle();
  const myCode = useMyFriendCode();

  const showError = (e: unknown) => {
    // ApiError carries the server's message for 404 and 429 alike; both are
    // things the person can act on, so neither is replaced with a generic one.
    const msg = e instanceof Error ? e.message : "";
    setErr(msg || "Couldn't look that up. Try again.");
  };

  const finish = () => {
    setValue("");
    setFound(null);
    onClose();
  };

  const sendByCode = (code: string) => {
    send.mutate({ code }, { onSuccess: finish, onError: showError });
  };

  const onChangeText = (text: string) => {
    setValue(text);
    // Editing the field can never leave a card describing the PREVIOUS
    // person on screen next to new text -- that is a factual claim about
    // someone, made from an answer to a question nobody is asking anymore
    // (kora#443's failure mode, reproduced here on every keystroke).
    setFound(null);
  };

  const onSubmit = () => {
    const raw = value.trim();
    if (!raw) {
      setErr("Enter a handle, email or friend code.");
      return;
    }
    setErr(null);
    setFound(null);

    // A leading @ is how people write a handle, and stripping it BEFORE the
    // email test is what stops "@ada" being routed as an email.
    const v = raw.replace(/^@/, "");
    if (v.includes("@")) {
      send.mutate({ email: v }, { onSuccess: finish, onError: showError });
      return;
    }

    setPending(true);
    lookup.mutate(v, {
      onSuccess: (r: LookupResult) => {
        setPending(false);
        setFound(r);
      },
      onError: (e: unknown) => {
        setPending(false);
        // A friend code from a mobile://friend/<code> link 404s here exactly
        // like a stranger's typo would -- it is not a handle. Retried as a
        // code send before surfacing an error, so a code already pasted into
        // a message thread keeps resolving now that handle lookup is the
        // primary path (kora#449 must not retire codes).
        if (e instanceof ApiError && e.status === 404 && FRIEND_CODE_SHAPE.test(v)) {
          sendByCode(v);
          return;
        }
        showError(e);
      },
    });
  };

  const onSend = () => {
    if (!found) return;
    // NOTE: SendRequest only resolves by email or friend_code (see
    // api/internal/social/handler.go's sendRequestBody) -- there is no
    // userId/handle path, and api/ is frozen for this task. `code` is the
    // closest existing shape; this will 404 against a real backend until
    // the API grows a way to send by the resolved user. Flagged for the
    // reviewer rather than left silent.
    send.mutate({ code: found.handle }, { onSuccess: finish, onError: showError });
  };

  const shareCode = () => {
    if (myCode.data) Share.share({ message: myCode.data.link }).catch(() => {});
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Add a friend</Overline>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Handle, email or friend code"
          placeholderTextColor={instrument.mut}
          accessibilityLabel="Handle, email or friend code"
          style={{ marginTop: 12, fontSize: 16, color: instrument.ink, backgroundColor: instrument.inset, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        <Button title="Find" onPress={onSubmit} disabled={send.isPending || pending} style={{ marginTop: 14 }} />

        {/* Exactly one of: the resolved card, the pending notice, the error,
            or nothing -- never more than one, and never the card while
            pending (kora#443). */}
        {found && !pending ? (
          <LookupResultCard result={found} onSend={onSend} sending={send.isPending} />
        ) : pending ? (
          <AppText style={{ color: instrument.mut, marginTop: 16 }}>Looking up…</AppText>
        ) : err ? (
          <AppText style={{ color: instrument.danger, marginTop: 10 }}>{err}</AppText>
        ) : null}

        <View style={{ height: 1, backgroundColor: instrument.hairline, marginVertical: 22 }} />

        <Overline>Your code</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
          <AppText rounded style={{ fontSize: 22, fontWeight: "700", color: instrument.ink, letterSpacing: 2, fontVariant: ["tabular-nums"] }}>
            {myCode.data?.code ?? "········"}
          </AppText>
          <Button title="Share" onPress={shareCode} variant="ghost" disabled={!myCode.data} />
        </View>
      </View>
    </Sheet>
  );
}
