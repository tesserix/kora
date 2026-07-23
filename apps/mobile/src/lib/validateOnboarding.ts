export function validateOnboardingNumbers(
  birthYear: string,
  heightCm: string,
  weightKg: string,
): string | null {
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
    return "Please enter a valid height in cm.";
  }
  if (w <= 0 || w > 500) {
    return "Please enter a valid weight in kg.";
  }
  return null;
}
