import { fireEvent, render } from "@testing-library/react-native";
import { ActivityFromHealth } from "../ActivityFromHealth";
import type { ActivityInference } from "@/health/inferActivity";

const label = (l: ActivityInference["level"]) =>
  ({ sedentary: "Sedentary", light: "Light", moderate: "Moderate", active: "Active", very_active: "Very active" })[l];

const inference: ActivityInference = {
  level: "moderate",
  meanSteps: 8400,
  workoutsPerWeek: 4,
  reason: "About 8,400 steps a day, and about 4 workouts a week over the last 14 days.",
};

const noop = () => {};

test("idle offers Health as an option and does not read anything yet", async () => {
  const onUseHealth = jest.fn();
  const ui = await render(
    <ActivityFromHealth status="idle" inference={null} levelLabel={label} onUseHealth={onUseHealth} onAccept={noop} />,
  );
  await fireEvent.press(ui.getByText("Use my Health data"));
  expect(onUseHealth).toHaveBeenCalledTimes(1);
});

test("a ready inference states the evidence AND the conclusion", async () => {
  // The user must be able to see why, not just what — an unexplained level is
  // indistinguishable from a guess.
  const ui = await render(
    <ActivityFromHealth status="ready" inference={inference} levelLabel={label} onUseHealth={noop} onAccept={noop} />,
  );
  expect(ui.getByText(inference.reason)).toBeTruthy();
  expect(ui.getByText("That reads as Moderate.")).toBeTruthy();
});

test("accepting reports the inferred level to the caller", async () => {
  const onAccept = jest.fn();
  const ui = await render(
    <ActivityFromHealth status="ready" inference={inference} levelLabel={label} onUseHealth={noop} onAccept={onAccept} />,
  );
  await fireEvent.press(ui.getByText("Sounds right"));
  expect(onAccept).toHaveBeenCalledWith("moderate");
});

test.each([
  ["denied" as const, /can't see your Health data/i],
  ["unavailable" as const, /isn't available on this device/i],
  ["insufficient" as const, /enough recent activity/i],
])("%s explains itself and defers to the manual list", async (status, pattern) => {
  const ui = await render(
    <ActivityFromHealth status={status} inference={null} levelLabel={label} onUseHealth={noop} onAccept={noop} />,
  );
  expect(ui.getByText(pattern)).toBeTruthy();
  // Crucially, no level is asserted in any of these states.
  expect(ui.queryByText(/That reads as/)).toBeNull();
});

test("the three unusable states each say something different, not one vague failure", async () => {
  const rendered: string[] = [];
  for (const status of ["denied", "unavailable", "insufficient"] as const) {
    const ui = await render(
      <ActivityFromHealth status={status} inference={null} levelLabel={label} onUseHealth={noop} onAccept={noop} />,
    );
    rendered.push(JSON.stringify(ui.toJSON()));
  }
  expect(new Set(rendered).size).toBe(3);
});

test("a ready status with a null inference renders no claim", async () => {
  // Defensive: status and payload must not be able to disagree into a blank
  // "That reads as ." on screen.
  const ui = await render(
    <ActivityFromHealth status="ready" inference={null} levelLabel={label} onUseHealth={noop} onAccept={noop} />,
  );
  expect(ui.queryByText(/That reads as/)).toBeNull();
});

test("loading disables the control so it cannot be double-requested", async () => {
  const onUseHealth = jest.fn();
  const ui = await render(
    <ActivityFromHealth status="loading" inference={null} levelLabel={label} onUseHealth={onUseHealth} onAccept={noop} />,
  );
  await fireEvent.press(ui.getByText("Reading Health data…"));
  expect(onUseHealth).not.toHaveBeenCalled();
});
