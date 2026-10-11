// One initials() for every Avatar chip in the app (kora#454). There used to
// be six local copies across app/profile.tsx, app/friends.tsx, app/social.tsx,
// app/(tabs)/index.tsx, app/(tabs)/more.tsx and LookupResultCard.tsx, split
// across two different algorithms (first-two-letters-of-first-word vs
// first+last initial) — so the same person rendered different letters
// depending which screen you were on.
//
// First + last initial wins here: it is what LookupResultCard already did
// (the newest and most deliberate of the six), and it is what people expect
// an avatar chip to show for a multi-word name — "Ada Grace Lovelace" reads
// as "AL", not "AG". A single-word name falls back to just its first letter;
// there is no "last word" to pair it with.
//
// Empty name -> "", never a letter. The literal "K" some call sites used to
// return for an empty/whitespace-only name read as a real person's initial
// (as if their name began with K) rather than as a fallback — worse than an
// empty glyph. `Avatar` already renders "" as a blank (but correctly shaped
// and bordered) circle; callers that want a friendlier placeholder glyph
// (LookupResultCard's "@") make that call themselves, on top of this.
export function initials(name: string | null | undefined): string {
  // \s+ (not a literal " ") collapses runs of multiple spaces, and trim()
  // first means a whitespace-only name filters down to zero parts rather
  // than one empty-string part.
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}
