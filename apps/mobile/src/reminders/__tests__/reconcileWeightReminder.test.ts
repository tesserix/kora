import { reconcileWeightReminder } from "../reconcileWeightReminder";
import * as scheduleModule from "../schedule";

jest.mock("../prefs", () => ({ loadPrefs: jest.fn().mockResolvedValue({}) }));
jest.mock("../customPrefs", () => ({ loadCustom: jest.fn().mockResolvedValue([]) }));
jest.mock("../weightPrefs", () => ({ loadWeightPref: jest.fn().mockResolvedValue({ enabled: true, hour: 7, minute: 0, days: [1] }) }));

test("reconciling re-applies the whole schedule with the supplied weigh-in date", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(new Date(2026, 7, 17, 6, 40));

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: new Date(2026, 7, 17, 6, 40) }),
  );
});

test("a null weigh-in date is passed through, so the reminder fires", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(null);

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: null }),
  );
});
