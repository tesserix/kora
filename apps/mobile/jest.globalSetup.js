// Pins the timezone for the whole Jest run.
//
// Without this the suite is accidentally zone-dependent: it exercises whatever
// zone the machine happens to be in, so a developer in Sydney and a CI runner
// in UTC test different code paths. That is not hypothetical — the queued-log
// day filter (src/offline/useQueuedLogs.ts) buckets by the DEVICE's calendar
// day, and on a UTC runner that is indistinguishable from bucketing by the UTC
// date, so the test guarding it would pass against either implementation.
//
// Asia/Kolkata is deliberate: a +05:30 offset means local and UTC calendar
// dates genuinely diverge for part of every day, and India observes no DST, so
// fixtures mean the same thing in every month of the year.
//
// This must be set here rather than in a test file or `setupFiles`: Jest gives
// each test module a copied `process.env`, so assigning TZ there never reaches
// Node's real timezone setter. globalSetup runs in the root Jest process before
// any worker is forked, and workers inherit the environment at spawn.
module.exports = () => {
  process.env.TZ = "Asia/Kolkata";
};
