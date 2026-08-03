import AsyncStorage from "@react-native-async-storage/async-storage";
import { currentUserId } from "@/lib/api";

const STORAGE_KEY = "kora.lastOwnerId";

// Every queued log is stamped with its author so a drain can never replay one
// user's meal into another's diary. Live auth is the truth whenever it exists —
// but on cold start Firebase restores the session from AsyncStorage
// asynchronously, and the Home tab is mounted and tappable before that lands
// (app/(tabs)/_layout.tsx only redirects to /sign-in from inside the
// onAuthStateChanged callback). A write in that window would otherwise be
// stamped with nothing and become permanently unsendable: drain skips unowned
// items by design, and nothing surfaces them.
//
// On a single-user device the last uid seen is exactly the one Firebase is
// about to restore, so remembering it closes the window completely.

// NoOwnerError is thrown when a log cannot be attributed to any account.
// Unlike most thrown errors here its message is user-facing copy, so a caller
// can show it verbatim; `name` is how this codebase discriminates errors
// without dragging api.ts into every consumer (see src/lib/apiErrorMessage.ts).
export class NoOwnerError extends Error {
  constructor() {
    super("Can't save this log — please sign in and try again.");
    this.name = "NoOwnerError";
  }
}

// rememberOwner records who is signed in. Called from the auth listener that
// installDrainTriggers already owns, so it fires on restore and on fresh
// sign-in alike.
export async function rememberOwner(uid: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, uid);
}

// forgetOwner drops the remembered uid on sign-out. Without it the next cold
// start would resolve the departed user as the owner of whatever the next
// person to pick up the phone taps, before auth has said otherwise.
export async function forgetOwner(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

// resolveOwnerId answers "whose log is this?" — live auth first, the last
// remembered uid while auth is still restoring, null only when nobody has ever
// signed in on this device. Never throws: a storage failure degrades to null
// and the caller refuses the write rather than queueing it unowned.
export async function resolveOwnerId(): Promise<string | null> {
  const live = currentUserId();
  if (live) return live;
  try {
    return await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
