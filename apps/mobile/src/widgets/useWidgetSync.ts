import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onAuthStateChanged } from "firebase/auth";
import { clearSnapshot, setSnapshot } from "../../modules/widget-bridge";
import { useDashboard } from "@/api/hooks";
import { STEP_GOAL } from "@/health/useHealth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { buildSnapshot } from "./snapshot";

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

/**
 * Keeps the home screen widget in step with the app. Mounted once, by the tabs
 * layout.
 *
 * Reads the dashboard through the SAME query key the home screen already uses,
 * so React Query serves it from cache — this adds no request.
 *
 * Writes only on real data. A failed fetch deliberately leaves the previous
 * snapshot in place: the figures on the home screen are still the user's real
 * ones, and replacing them with an empty state because the network blipped
 * would be a downgrade, not a correction.
 */
export function useWidgetSync(): void {
  const qc = useQueryClient();
  const dashboard = useDashboard(today());
  const summary = dashboard.data;

  // undefined = no auth event observed yet this mount. Distinct from null
  // (confirmed signed out) so a fresh mount's first callback — whatever uid
  // it reports — is never treated as a "switch" with nothing to compare
  // against.
  const lastUid = useRef<string | null | undefined>(undefined);

  // Sign-out is SUBSCRIBED to, not read. currentUserId() would be a snapshot
  // taken at render time, and nothing re-renders this hook when auth drops —
  // on sign-out the tabs layout unmounts and the clear would never fire.
  // Mirrors usePushRegistration in src/lib/push.ts.
  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    return onAuthStateChanged(auth, (user) => {
      const uid = user ? user.uid : null;
      const prev = lastUid.current;
      // Sign-out always clears. A DIFFERENT uid replacing a known previous
      // one also clears — otherwise user B's dashboard write would land on
      // top of user A's still-cached snapshot for however long B's first
      // fetch takes. Re-emissions of the SAME uid (token refresh, etc.) and
      // the very first callback of a fresh mount must not clear: there is
      // nothing stale to protect against yet.
      if (uid === null || (prev !== undefined && prev !== uid)) {
        clearSnapshot();
        // useDashboard's key is owner-scoped (src/api/hooks.ts), which is the
        // structural fix — but that alone only stops a NEW query from
        // crossing accounts. staleTime is 30s, so an already-cached
        // ["dashboard", A, date] entry is still fair game to be served
        // synchronously if anything ever re-keys or re-reads it during the
        // switch window. Clearing the whole client on every uid transition
        // is the defense-in-depth twin of that fix: no cached response from
        // any account can outlive the account it was fetched for. Mirrors
        // the ownerId key fix in src/offline/useQueuedLogs.ts.
        qc.clear();
      }
      lastUid.current = uid;
    });
  }, [qc]);

  useEffect(() => {
    if (!summary) return;
    setSnapshot(JSON.stringify(buildSnapshot({ summary, stepGoal: STEP_GOAL })));
  }, [summary]);
}
