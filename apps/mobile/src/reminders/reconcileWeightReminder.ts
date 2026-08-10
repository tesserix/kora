import { loadPrefs } from "./prefs";
import { loadCustom } from "./customPrefs";
import { loadWeightPref } from "./weightPrefs";
import { applyAllReminders } from "./schedule";

// reconcileWeightReminder recomputes the entire notification schedule with a
// fresh view of when the user last weighed in. It exists because a one-shot
// DATE trigger has to be re-armed whenever the facts change, and because
// applyAllReminders cancels everything — so the meal and custom reminders must
// be re-applied in the same breath.
export async function reconcileWeightReminder(lastWeighedAt: Date | null): Promise<void> {
  const [mealPrefs, customs, pref] = await Promise.all([loadPrefs(), loadCustom(), loadWeightPref()]);
  await applyAllReminders(mealPrefs, customs, { pref, lastWeighedAt, now: new Date() });
}
