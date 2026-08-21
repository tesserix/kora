import type { ResolvedCandidate } from "@/api/types";
import { isLoggable } from "@/lib/candidateTier";

// A stable per-candidate key for tracking add-to-diary success across retry
// attempts. Combines the candidate's position (stable for the lifetime of a
// single resolution) with its food_item_id (in case ids ever duplicate) so
// two candidates never collide.
export function candidateKey(candidate: ResolvedCandidate, index: number): string {
  return `${index}:${candidate.item.id}`;
}

// One candidate this attempt tried to log, carrying the index it was found at
// (the DetectedCard row) and the ledger key it was recorded under.
export type LedgerEntry = {
  candidate: ResolvedCandidate;
  index: number;
  key: string;
};

export type LedgerAttempt = {
  /** What this attempt actually submitted — already-logged rows are absent. */
  pending: readonly LedgerEntry[];
  succeeded: readonly LedgerEntry[];
  failed: readonly LedgerEntry[];
  /**
   * How many of this resolution's candidates are logged once this attempt is
   * accounted for: the ledger snapshot it started from, plus what just landed.
   * Computed from that snapshot rather than re-read from state, so a caller's
   * message can never depend on when React flushes the ledger write.
   */
  loggedCount: number;
};

export type RetryLedgerRun = {
  /** The candidates as the card showed them — before any filtering. */
  candidates: readonly ResolvedCandidate[];
  /** Rows the user unticked (kora#183). */
  excluded: ReadonlySet<number>;
  /** The ledger as this press saw it. */
  logged: ReadonlySet<string>;
  /** How to log ONE candidate. The only part that differs between callers. */
  logCandidate: (candidate: ResolvedCandidate, index: number) => Promise<unknown>;
  /** The ledger's setState. Only ever called with a functional updater. */
  markLogged: (update: (prev: Set<string>) => Set<string>) => void;
};

// The retry ledger: the one rule that decides what a second press of
// "Add to diary" / "Confirm" re-submits.
//
// It is extracted (kora#144) because both capture.tsx and capture-review.tsx
// implement it over different backends — the createLog mutation and the
// offline appendLog queue — and getting it wrong DOUBLE-LOGS A MEAL. That was
// a real bug on the capture-integrity branch: neither backend can recognise a
// duplicate after the fact (appendLog mints a fresh log id per call, and the
// server binds it as the log's identity), so the only place the rule can live
// is here, before submission.
//
// The rule, in order:
//
//  1. Key every candidate off the FULL list, the same way DetectedCard indexes
//     its rows, so a key computed now lines up with one an earlier attempt
//     recorded.
//  2. Drop rows that are not loggable, rows the user excluded, and — the
//     correctness-critical one — rows already in the ledger. Without the last
//     filter a retry after a partial failure re-logs everything that already
//     succeeded.
//  3. allSettled, never all: one rejection must not hide whether the other
//     candidates were logged, and the outcome list is what the caller uses to
//     decide whether it is safe to delete/navigate.
//  4. Union the keys that landed back into the ledger, never replace, and via
//     a functional updater so the write is taken against the ledger at commit
//     time rather than the snapshot this press captured (kora#204).
//
// Deliberately NOT shared, because the two screens genuinely differ: what
// counts as loggable input (this takes the candidates the caller has already
// resolved — capture.tsx passes its hand-promoted effectiveResolution), how a
// failure is reported (a named list vs a count), and what a clean attempt then
// does (navigate vs delete the queued capture and its media).
export async function runRetryLedger({
  candidates,
  excluded,
  logged,
  logCandidate,
  markLogged,
}: RetryLedgerRun): Promise<LedgerAttempt> {
  const pending: LedgerEntry[] = candidates
    .map((candidate, index) => ({ candidate, index, key: candidateKey(candidate, index) }))
    .filter(({ candidate }) => isLoggable(candidate))
    .filter(({ index }) => !excluded.has(index))
    .filter(({ key }) => !logged.has(key));

  const outcomes = await Promise.allSettled(
    pending.map(({ candidate, index }) => logCandidate(candidate, index)),
  );

  const succeeded = pending.filter((_, i) => outcomes[i]?.status === "fulfilled");
  const failed = pending.filter((_, i) => outcomes[i]?.status === "rejected");
  const succeededKeys = succeeded.map(({ key }) => key);

  markLogged((prev) => new Set([...prev, ...succeededKeys]));

  return {
    pending,
    succeeded,
    failed,
    loggedCount: new Set([...logged, ...succeededKeys]).size,
  };
}
