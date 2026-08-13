// The engraved "portion is a guess" marker (#138) is visual-only unless it
// also reaches the accessible name — a screen reader that only announces a
// row's plain description would let a system-guessed portion read as
// measured fact for those users. Shared by every call site that marks a row
// (diary, Home, queued) so the wording cannot drift between them.
export function accessibleMealLabel(description: string, portionAssumed: boolean): string {
  return portionAssumed ? `${description}, portion is a guess` : description;
}
