// Range-validates the ALWAYS-METRIC height (cm) and weight (kg) values. The
// optional unit labels only affect the error copy shown to the user, so an
// imperial user sees "in ft/in" / "in lb" instead of "in cm" / "in kg" — the
// numbers validated are metric regardless.
export function validateOnboardingNumbers(
  birthYear: string,
  heightCm: string,
  weightKg: string,
  opts?: { heightUnit?: string; weightUnit?: string },
): string | null {
  const heightUnit = opts?.heightUnit ?? "cm";
  const weightUnit = opts?.weightUnit ?? "kg";
  const by = Number(birthYear);
  const h = Number(heightCm);
  const w = Number(weightKg);

  if (!birthYear || !heightCm || !weightKg) {
    return "Please fill in your birth year, height, and weight.";
  }
  if (Number.isNaN(by) || Number.isNaN(h) || Number.isNaN(w)) {
    return "Birth year, height, and weight must be numbers.";
  }
  if (by < 1900 || by > 2020) {
    return "Please enter a valid birth year.";
  }
  if (h <= 0 || h > 260) {
    return `Please enter a valid height in ${heightUnit}.`;
  }
  if (w <= 0 || w > 500) {
    return `Please enter a valid weight in ${weightUnit}.`;
  }
  return null;
}
