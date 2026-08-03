// AsyncStorage has no transactions, and every write in this directory is a
// read-modify-write over one whole JSON blob. Two of them in flight at once
// both read the same value and whichever saves last silently drops the other's
// change — for the queue that is the meal the "Logged X" toast just promised
// was saved, gone. This is not hypothetical: drains fire on foreground and on
// reconnect, which is precisely when the user is interacting.
//
// createLock returns an INDEPENDENT serialiser. Each storage key gets its own —
// the queue and the food cache have no ordering relationship, and putting them
// on one chain would make a slow cache write delay a drain for no reason.
export function createLock(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    // `then(work, work)` on both settlement paths, so one rejected critical
    // section cannot wedge the chain and skip every write queued behind it.
    const next = tail.then(work, work);
    // The chain tracks completion only. Swallowing here keeps a rejection from
    // becoming an unhandled promise rejection on the internal handle; the
    // caller still receives `next` and its rejection.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
