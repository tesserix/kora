import { candidateKey, runRetryLedger } from "../retryLedger";
import type { ResolvedCandidate } from "@/api/types";

function candidate(id: string, name = id): ResolvedCandidate {
  return {
    item: { id, name } as ResolvedCandidate["item"],
    portion_grams: 100,
    kcal: 100,
    match_score: 0.9,
    match_tier: "full_text",
    tier: "auto",
  };
}

// A stand-in for the screens' `setLoggedCandidateKeys`: it applies the
// updater against the ledger it currently holds, exactly as React would, so a
// test can tell a functional updater apart from a closed-over write.
function ledger(initial: string[] = []) {
  let current = new Set(initial);
  return {
    snapshot: () => current,
    markLogged: (update: (prev: Set<string>) => Set<string>) => {
      current = update(current);
    },
    keys: () => [...current].sort(),
  };
}

test("logs every loggable candidate the user did not exclude", async () => {
  const logged: string[] = [];
  const store = ledger();

  const attempt = await runRetryLedger({
    candidates: [candidate("a"), candidate("b"), candidate("c")],
    excluded: new Set([1]),
    logged: store.snapshot(),
    markLogged: store.markLogged,
    logCandidate: async (c) => {
      logged.push(c.item.id);
    },
  });

  expect(logged).toEqual(["a", "c"]);
  expect(attempt.succeeded.map((e) => e.candidate.item.id)).toEqual(["a", "c"]);
  expect(attempt.failed).toEqual([]);
  expect(attempt.loggedCount).toBe(2);
});

// Keys carry the candidate's INDEX in the full list, so excluding a row does
// not shift the keys of the rows after it. A key computed on a retry has to
// line up with the one an earlier attempt recorded, or the ledger stops
// recognising what it already logged.
test("keys are indexed against the full candidate list, not the filtered one", async () => {
  const store = ledger();
  const candidates = [candidate("a"), candidate("b"), candidate("c")];

  const attempt = await runRetryLedger({
    candidates,
    excluded: new Set([0]),
    logged: store.snapshot(),
    markLogged: store.markLogged,
    logCandidate: async () => {},
  });

  expect(attempt.pending.map((e) => e.key)).toEqual(["1:b", "2:c"]);
  expect(candidateKey(candidates[2], 2)).toBe("2:c");
  expect(attempt.pending.map((e) => e.index)).toEqual([1, 2]);
});

// THE double-log guard. A partial failure leaves the succeeded rows in the
// ledger; the retry must resubmit only what failed. Re-submitting a
// succeeded row writes a SECOND diary entry — neither backend can recognise
// the duplicate after the fact.
test("a retry after a partial failure resubmits only what failed", async () => {
  const store = ledger();
  const attempts: string[][] = [];

  const first = await runRetryLedger({
    candidates: [candidate("a"), candidate("b")],
    excluded: new Set(),
    logged: store.snapshot(),
    markLogged: store.markLogged,
    logCandidate: async (c) => {
      attempts.push([c.item.id]);
      if (c.item.id === "b") throw new Error("network");
    },
  });

  expect(first.succeeded.map((e) => e.key)).toEqual(["0:a"]);
  expect(first.failed.map((e) => e.candidate.item.name)).toEqual(["b"]);
  expect(first.loggedCount).toBe(1);
  expect(store.keys()).toEqual(["0:a"]);

  const submitted: string[] = [];
  const second = await runRetryLedger({
    candidates: [candidate("a"), candidate("b")],
    excluded: new Set(),
    logged: store.snapshot(),
    markLogged: store.markLogged,
    logCandidate: async (c) => {
      submitted.push(c.item.id);
    },
  });

  // "a" is NOT resubmitted — that is the whole point.
  expect(submitted).toEqual(["b"]);
  expect(second.pending.map((e) => e.key)).toEqual(["1:b"]);
  expect(store.keys()).toEqual(["0:a", "1:b"]);
  expect(second.loggedCount).toBe(2);
});

// One rejection must not abandon the candidates that could still be logged:
// with Promise.all the "a" below would never be submitted at all, and the
// user would be told nothing about it.
test("a rejection does not abandon the other candidates", async () => {
  const store = ledger();
  const submitted: string[] = [];

  const attempt = await runRetryLedger({
    candidates: [candidate("boom"), candidate("a")],
    excluded: new Set(),
    logged: store.snapshot(),
    markLogged: store.markLogged,
    logCandidate: async (c) => {
      submitted.push(c.item.id);
      if (c.item.id === "boom") throw new Error("nope");
    },
  });

  expect(submitted).toEqual(["boom", "a"]);
  expect(attempt.succeeded.map((e) => e.candidate.item.id)).toEqual(["a"]);
  expect(attempt.failed.map((e) => e.candidate.item.id)).toEqual(["boom"]);
});

// Union, never replace, and via a functional updater. The ledger this press
// captured is stale by the time the awaits resolve; a write built from that
// snapshot would drop any key committed in the meantime — and a dropped key
// is a row that gets logged twice on the next press.
test("the ledger write is a union taken at commit time, not against the captured snapshot", async () => {
  const store = ledger(["0:a"]);
  const captured = store.snapshot();

  // A key lands from elsewhere while the submissions are in flight.
  const attempt = await runRetryLedger({
    candidates: [candidate("a"), candidate("b")],
    excluded: new Set(),
    logged: captured,
    markLogged: store.markLogged,
    logCandidate: async () => {
      store.markLogged((prev) => new Set([...prev, "9:concurrent"]));
    },
  });

  expect(store.keys()).toEqual(["0:a", "1:b", "9:concurrent"]);
  // loggedCount reports what THIS press knows about, never the concurrent
  // write — the message it feeds must not depend on React's flush timing.
  expect(attempt.loggedCount).toBe(2);
});

// A retry that finds everything already logged must still be a clean, empty
// attempt: capture-review deletes the queued capture on a no-failure outcome,
// so an empty pending list has to read as success rather than as nothing
// happening.
test("an attempt with nothing left to log succeeds with an empty pending list", async () => {
  const store = ledger(["0:a"]);
  const submitted: string[] = [];

  const attempt = await runRetryLedger({
    candidates: [candidate("a")],
    excluded: new Set(),
    logged: store.snapshot(),
    markLogged: store.markLogged,
    logCandidate: async (c) => {
      submitted.push(c.item.id);
    },
  });

  expect(submitted).toEqual([]);
  expect(attempt.pending).toEqual([]);
  expect(attempt.failed).toEqual([]);
  expect(attempt.loggedCount).toBe(1);
});
