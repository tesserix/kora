// The device-local calendar date, sent with every write so the server files a
// log under the day the user actually experienced (kora#84).
//
// Why the client supplies this rather than the server computing it: the
// offline queue replays writes later, possibly from another timezone. A meal
// captured in London and drained after landing in Sydney must keep London's
// date, and a server stamping the date on receipt would file it on the wrong
// day.
//
// "en-CA" is the locale that yields YYYY-MM-DD. It matches
// app/(tabs)/diary.tsx and src/offline/useQueuedLogs.ts, so queued rows and
// server rows agree by construction rather than by coincidence.
//
// Evaluated per call, never cached: a session left open across midnight would
// otherwise keep filing logs under yesterday.
export function localDateNow(): string {
  return new Date().toLocaleDateString("en-CA");
}
