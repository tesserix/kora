const MINUTES_PER_HOUR = 60;

/**
 * A night's sleep in the shape the Health app writes it: "4h 26m".
 *
 * Kora rendered `${lastNightHours}h` — "4.4h" against Health's "4h 26m". Both
 * were correct and neither could be checked against the other at a glance,
 * which is the whole point of a figure whose only external reference is the
 * platform's own.
 *
 * Rounding happens ONCE, here, on minutes. `useHealth` used to round the hours
 * to one decimal before storing them, which quantised the value to 6-minute
 * steps: 4h 26m became 4.4h became "4h 24m" — a two-minute error introduced
 * purely by formatting. The stored value now keeps its precision and this is
 * the only place it is rounded.
 */
export function sleepDurationLabel(hours: number): string {
  const totalMinutes = Math.round(hours * MINUTES_PER_HOUR);
  const wholeHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;

  // Under an hour reads as minutes alone — "0h 45m" is how a machine says it.
  if (wholeHours === 0) return `${minutes}m`;
  // And a whole hour drops the "0m" rather than padding it.
  return minutes === 0 ? `${wholeHours}h` : `${wholeHours}h ${minutes}m`;
}
