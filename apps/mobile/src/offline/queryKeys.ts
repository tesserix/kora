// The react-query key the diary's queued rows live under. It sits in its own
// module so drainLogs — plain async code, no React — can invalidate it without
// importing the hook that reads it.
export const QUEUED_LOGS_KEY = "queuedLogs";

// The react-query key the diary's queued CAPTURE rows live under. Separate
// from QUEUED_LOGS_KEY so a capture pass does not invalidate log rows that
// did not change.
export const QUEUED_CAPTURES_KEY = "queuedCaptures";
