import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import CoachScreen from "../coach";

const mockNudges = jest.fn();
const mockThread = jest.fn();
const mockAsk = jest.fn();
const mockNudgesRefetch = jest.fn();
const mockThreadRefetch = jest.fn();
const mockAskMutate = jest.fn();
const mockOnline = jest.fn(() => true);

jest.mock("expo-router", () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("@/api/hooks", () => ({
  useAIUsage: () => mockAIUsage(),
  useCoachNudges: () => mockNudges(),
  useCoachThread: () => mockThread(),
  useCoachAsk: () => mockAsk(),
}));
jest.mock("@/offline/connectivity", () => ({ useIsOnline: () => mockOnline() }));

const mockAIUsage = jest.fn(() => ({ data: undefined }));

const nudgeData = {
  nudges: [{ kind: "protein", title: "Protein", text: "142 / 160g — 18g to go" }],
  show_support: false,
};
const threadData = {
  turns: [
    { role: "user", text: "How is my protein?", citations: [], created_at: "2026-08-19T00:00:00Z" },
    {
      role: "otto",
      text: "You have 18g to go today.",
      citations: [{ label: "Protein", value: "142 / 160g" }],
      created_at: "2026-08-19T00:00:01Z",
    },
  ],
  show_support: false,
};

beforeEach(() => {
  mockNudgesRefetch.mockClear();
  mockThreadRefetch.mockClear();
  mockAskMutate.mockReset();
  mockOnline.mockReturnValue(true);
  mockAIUsage.mockReturnValue({ data: undefined });
  (router.push as jest.Mock).mockClear();
  mockNudges.mockReturnValue({ data: nudgeData, isLoading: false, isError: false, refetch: mockNudgesRefetch });
  mockThread.mockReturnValue({ data: threadData, isLoading: false, isError: false, refetch: mockThreadRefetch });
  mockAsk.mockReturnValue({ mutate: mockAskMutate, isPending: false });
});

test("renders grounded focus, stored conversation, and citation chips", async () => {
  const { getByText, getByTestId } = await render(<CoachScreen />);

  expect(getByTestId("coach-focus-cluster")).toBeTruthy();
  expect(getByText("Protein")).toBeTruthy();
  expect(getByText("142 / 160g — 18g to go")).toBeTruthy();
  expect(getByText("How is my protein?")).toBeTruthy();
  expect(getByText("You have 18g to go today.")).toBeTruthy();
  expect(getByText("Protein · 142 / 160g")).toBeTruthy();
});

test("a structured agent proposal is reviewable but never activates itself", async () => {
  mockThread.mockReturnValue({
    data: {
      turns: [{
        role: "otto",
        text: "A short walk after lunch fits the routine you requested.",
        citations: [],
        created_at: "2026-08-19T00:00:01Z",
        proposal: {
          id: "proposal-1",
          title: "Walk after lunch",
          kind: "walking",
          cadence: "fixed",
          weekdays_mask: 62,
          start_minute: 780,
          interval_minutes: null,
          end_minute: null,
          timezone: "Australia/Melbourne",
          starts_on: "2026-08-22",
          ends_on: null,
          source: "meal_planner",
          agent_name: "Kora Meal Planner",
          reviewed_by: "Kora Nutrition Coach",
          accepted_commitment_id: null,
          accepted_at: null,
          created_at: "2026-08-19T00:00:01Z",
        },
      }],
      show_support: false,
    },
    isLoading: false,
    isError: false,
    refetch: mockThreadRefetch,
  });

  const { getByLabelText, getByText } = await render(<CoachScreen />);
  expect(getByText("Suggested by Kora Meal Planner · reviewed by Kora Nutrition Coach")).toBeTruthy();
  fireEvent.press(getByLabelText("Review suggested commitment"));

  expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
    pathname: "/mentor-commitment",
    params: expect.objectContaining({ proposalId: "proposal-1", title: "Walk after lunch" }),
  }));
});

test("show_support adds help without replacing safe focus cards", async () => {
  mockNudges.mockReturnValue({
    data: { ...nudgeData, show_support: true },
    isLoading: false,
    isError: false,
    refetch: mockNudgesRefetch,
  });

  const { getByText } = await render(<CoachScreen />);

  expect(getByText("A little extra support")).toBeTruthy();
  expect(getByText("Protein")).toBeTruthy();
});

test("sending shows the optimistic user turn and asks the coach", async () => {
  mockThread.mockReturnValue({
    data: { turns: [], show_support: false },
    isLoading: false,
    isError: false,
    refetch: mockThreadRefetch,
  });
  const { getByLabelText, getByText } = await render(<CoachScreen />);

  await fireEvent.changeText(getByLabelText("Ask Otto a nutrition question"), "How is my fibre?");
  await fireEvent.press(getByLabelText("Send question"));

  expect(mockAskMutate).toHaveBeenCalledWith("How is my fibre?", expect.any(Object));
  expect(getByText("How is my fibre?")).toBeTruthy();
  expect(getByText("Coach is thinking…")).toBeTruthy();
});

test("the answering agent is named on its bubble and on the next thinking line", async () => {
  mockThread.mockReturnValue({
    data: { turns: [], show_support: false },
    isLoading: false,
    isError: false,
    refetch: mockThreadRefetch,
  });
  mockAskMutate.mockImplementation((_question, options) =>
    options.onSuccess({
      answer: "You have 18g to go today.",
      citations: [],
      show_support: false,
      agent: { name: "Nutrition Coach", skill: "nutrition-guidance" },
    }),
  );
  const { getByLabelText, getByText } = await render(<CoachScreen />);

  await fireEvent.changeText(getByLabelText("Ask Otto a nutrition question"), "How is my fibre?");
  await fireEvent.press(getByLabelText("Send question"));

  // The named agent carries into the next question's thinking line.
  mockAskMutate.mockImplementation(() => undefined);
  await fireEvent.changeText(getByLabelText("Ask Otto a nutrition question"), "And my fat?");
  await fireEvent.press(getByLabelText("Send question"));

  expect(getByText("Nutrition Coach is thinking…")).toBeTruthy();
  expect(getByText("OTTO · NUTRITION COACH")).toBeTruthy();
});

test("an answer with no agent stays attributed to plain Otto", async () => {
  mockThread.mockReturnValue({
    data: {
      turns: [
        { role: "otto", text: "Plain answer.", citations: [], created_at: "2026-08-19T00:00:01Z" },
      ],
      show_support: false,
    },
    isLoading: false,
    isError: false,
    refetch: mockThreadRefetch,
  });
  const { getByText, queryByText, getByLabelText } = await render(<CoachScreen />);

  expect(getByLabelText("Otto: Plain answer.")).toBeTruthy();
  expect(queryByText(/OTTO ·/)).toBeNull();
  expect(getByText("Plain answer.")).toBeTruthy();
});

test("a failed answer keeps the question and provides an inline retry", async () => {
  mockAskMutate.mockImplementation((_question, options) => options.onError(new Error("offline")));
  const { getByLabelText, getByText } = await render(<CoachScreen />);
  const input = getByLabelText("Ask Otto a nutrition question");

  await fireEvent.changeText(input, "What should I focus on?");
  await fireEvent.press(getByLabelText("Send question"));

  expect(getByText("Couldn't get an answer. Your question is still here.")).toBeTruthy();
  expect(getByLabelText("Ask Otto a nutrition question").props.value).toBe("What should I focus on?");
  await fireEvent.press(getByLabelText("Retry question"));
  expect(mockAskMutate).toHaveBeenCalledTimes(2);
});

test("focus and conversation failures stay independent and retryable", async () => {
  mockNudges.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: mockNudgesRefetch });
  mockThread.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: mockThreadRefetch });

  const { getByText, getByLabelText } = await render(<CoachScreen />);

  expect(getByText("Couldn't refresh today's focus.")).toBeTruthy();
  expect(getByText(/I couldn't load your earlier conversation/)).toBeTruthy();
  await fireEvent.press(getByLabelText("Retry focus"));
  await fireEvent.press(getByLabelText("Retry conversation"));
  expect(mockNudgesRefetch).toHaveBeenCalledTimes(1);
  expect(mockThreadRefetch).toHaveBeenCalledTimes(1);
});

test("offline mode disables send with a clear reason", async () => {
  mockOnline.mockReturnValue(false);
  const { getByText, getByLabelText } = await render(<CoachScreen />);

  expect(getByText("You're offline — reconnect to ask Otto.")).toBeTruthy();
  expect(getByLabelText("Send question").props.accessibilityState.disabled).toBe(true);
});

test("a suggestion sends the exact grounded question", async () => {
  const { getByLabelText } = await render(<CoachScreen />);

  await fireEvent.press(getByLabelText("Ask: How is my protein today?"));

  await waitFor(() =>
    expect(mockAskMutate).toHaveBeenCalledWith("How is my protein today?", expect.any(Object)),
  );
});

test("a spent allowance offers a top-up next to the reply that says so", async () => {
  mockAIUsage.mockReturnValue({
    data: {
      daily: { used: 20, limit: 20, remaining: 0, resets_at: "2026-08-23T00:00:00Z" },
      weekly: { used: 20, limit: 100, remaining: 80, resets_at: "2026-08-24T00:00:00Z" },
      monthly: { used: 20, limit: 300, remaining: 280, resets_at: "2026-09-01T00:00:00Z" },
    },
  });

  const { getByLabelText, getByText } = await render(<CoachScreen />);

  expect(getByText(/Your AI allowance is spent/)).toBeTruthy();
  await fireEvent.press(getByLabelText("Add requests"));
  expect(router.push).toHaveBeenCalledWith("/ai-top-up");
});

test("a healthy allowance says nothing about paying", async () => {
  const { queryByLabelText } = await render(<CoachScreen />);

  expect(queryByLabelText("Add requests")).toBeNull();
});
