import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { PlanOtto } from "../PlanOtto";
import type { PlanOttoResponse } from "@/api/types";
import type { PlanDraft } from "@/lib/planDraft";

const mockMutate = jest.fn();
jest.mock("@/api/hooks", () => ({
  usePlanOtto: () => ({ mutate: mockMutate, isPending: false }),
}));

const DRAFT: PlanDraft = {
  sex: "female",
  birth_year: 1990,
  height_cm: 165,
  weight_kg: 70,
  activity_level: "moderate",
  goal: "fat_loss",
  goal_weight_kg: 64,
  pace_kg_per_week: 0.5,
};

const PROPOSAL: PlanOttoResponse = {
  reply: "Here's a version with less carbs.",
  show_support: false,
  proposal: {
    draft: {
      ...DRAFT,
      timezone: "Asia/Kolkata",
      goal_weight_kg: 64,
      pace_kg_per_week: 0.5,
      target_kcal_override: null,
      target_protein_override_g: 125,
    },
    targets: {} as NonNullable<PlanOttoResponse["proposal"]>["targets"],
    changes: [
      { field: "protein_g", from: 146, to: 125 },
      { field: "carbs_g", from: 120, to: 141 },
      { field: "activity_level", from: "moderate", to: "light" },
    ],
  },
};

const onUse = jest.fn();

async function ask(message = "less carbs") {
  await fireEvent.changeText(screen.getByLabelText("Ask Otto a nutrition question"), message);
  await fireEvent.press(screen.getByLabelText("Send question"));
}

async function answer(res: PlanOttoResponse) {
  await act(() => mockMutate.mock.calls.at(-1)[1].onSuccess(res));
}

async function fail(status: number) {
  const err = Object.assign(new Error("x"), { name: "ApiError", status });
  await act(() => mockMutate.mock.calls.at(-1)[1].onError(err));
}

beforeEach(() => jest.clearAllMocks());

test("sends message with draft", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  expect(mockMutate).toHaveBeenCalledWith({ message: "less carbs", draft: DRAFT }, expect.any(Object));
  expect(screen.getByText(/Kora checks every number before it's used\./)).toBeTruthy();
});

test("shows proposal changes", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer(PROPOSAL);
  expect(screen.getByText("Here's a version with less carbs.")).toBeTruthy();
  expect(screen.getByText("146 → 125 g")).toBeTruthy();
  expect(screen.getByText("Carbs")).toBeTruthy();
  expect(screen.getByText("Moderate → Light")).toBeTruthy();
});

test("use this calls onUse with proposal draft", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer(PROPOSAL);
  await fireEvent.press(screen.getByText("Use this"));
  // Normalised like server data: nulls become absent keys.
  expect(onUse).toHaveBeenCalledWith({
    ...DRAFT,
    timezone: "Asia/Kolkata",
    target_protein_override_g: 125,
  });
  expect(screen.queryByText("Use this")).toBeNull();
});

test("not now hides the card", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer(PROPOSAL);
  await fireEvent.press(screen.getByText("Not now"));
  expect(screen.queryByText("146 → 125 g")).toBeNull();
  expect(screen.getByText("Here's a version with less carbs.")).toBeTruthy();
  expect(onUse).not.toHaveBeenCalled();
});

test("only the newest proposal is offered", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer(PROPOSAL);
  await ask("more protein");
  await answer(PROPOSAL);
  expect(screen.getAllByText("Use this")).toHaveLength(1);
});

test("budget exhausted copy", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await fail(429);
  expect(
    screen.getByText("You've used your Otto allowance for now. You can still edit the numbers directly."),
  ).toBeTruthy();
  expect(screen.getByLabelText("Send question").props.accessibilityState.disabled).toBe(false);
});

test("failure copy", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await fail(502);
  expect(screen.getByText("Otto couldn't answer. You can still edit the numbers directly.")).toBeTruthy();
});

test("a proposal draft that does not round-trip shows the failure copy, not the card", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  const bad = { ...PROPOSAL, proposal: { ...PROPOSAL.proposal!, draft: { ...PROPOSAL.proposal!.draft, goal: "bulk" } } };
  await answer(bad as PlanOttoResponse);
  expect(screen.queryByText("Use this")).toBeNull();
  expect(screen.getByText("Otto couldn't answer. You can still edit the numbers directly.")).toBeTruthy();
});

test("support card when show_support", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer({ reply: "I'll keep your calories where they are for now.", proposal: null, show_support: true });
  expect(screen.getByText("A little extra support")).toBeTruthy();
});

test("an edit after the answer withdraws the proposal", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer(PROPOSAL);
  expect(screen.getByText("Use this")).toBeTruthy();
  await screen.rerender(<PlanOtto draft={{ ...DRAFT, weight_kg: 71 }} onUse={onUse} />);
  expect(screen.queryByText("Use this")).toBeNull();
  expect(screen.queryByText("146 → 125 g")).toBeNull();
  expect(screen.getByText("Here's a version with less carbs.")).toBeTruthy();
});

test("sending a new message withdraws the previous proposal", async () => {
  await render(<PlanOtto draft={DRAFT} onUse={onUse} />);
  await ask();
  await answer(PROPOSAL);
  await ask("more protein");
  expect(screen.queryByText("Use this")).toBeNull();
});
