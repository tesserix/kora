// Elapsed-time copy for a declared fast, shown on the diary's "End fast"
// control. The 48h cap mirrors the server's own cap on how much of a fast
// counts toward the eating-disorder risk signal (kora#407) — a fast someone
// forgot to end must read as capped, not as an ever-growing number.
const CAP_MS = 48 * 60 * 60 * 1000;

/** "3h 20m", "45m", or the 48h cap — never more. */
export function fastElapsedLabel(startedAt: string): string {
  // Math.max(0, ...) guards clock skew (a started_at briefly in the future)
  // rather than surfacing a negative duration.
  const elapsedMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const cappedMs = Math.min(elapsedMs, CAP_MS);
  const totalMinutes = Math.floor(cappedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
