import AsyncStorage from "@react-native-async-storage/async-storage";

// Set once the offline state below has been checked against the identity
// provider. Its absence on an existing install means the queues were written
// while Kora signed in through Firebase.
const MARKER_KEY = "kora.identityProvider";
const PROVIDER = "zitadel";

// Every queued log and capture is stamped with its author's uid, and so is the
// remembered owner (owner.ts). Firebase uids and Zitadel subjects never match,
// so on the first launch after the move none of these can ever drain: drain
// skips rows that are not the signed-in user's, permanently. Dropping them is
// the honest outcome; the testers they belong to were wiped server-side before
// cutover anyway. Media files the dropped captures named are reclaimed by the
// orphan sweep that runs straight after (drainTriggers.ts).
const FIREBASE_ERA_KEYS = ["kora.logQueue", "kora.captureQueue", "kora.lastOwnerId"];

let ran: Promise<void> | null = null;

// purgeFirebaseEraOfflineState runs at most once per process and, through the
// marker, once per install. It never rejects: a failure leaves the marker
// unset, so the next launch tries again.
export function purgeFirebaseEraOfflineState(): Promise<void> {
  ran ??= (async () => {
    try {
      if ((await AsyncStorage.getItem(MARKER_KEY)) === PROVIDER) return;
      await AsyncStorage.multiRemove(FIREBASE_ERA_KEYS);
      await AsyncStorage.setItem(MARKER_KEY, PROVIDER);
    } catch {
      ran = null;
    }
  })();
  return ran;
}

export function __resetIdentityCutoverForTests(): void {
  ran = null;
}
