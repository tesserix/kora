import { fireEvent, render } from "@testing-library/react-native";

const mockMutate = jest.fn();
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/api/hooks", () => ({
  useCreateChallenge: () => ({ mutate: mockMutate, isPending: false }),
}));

import { CreateChallengeSheet } from "../CreateChallengeSheet";

beforeEach(() => {
  mockMutate.mockReset();
  mockPush.mockReset();
});

test("blank title shows an error and does not mutate", async () => {
  const { getByText } = await render(<CreateChallengeSheet visible groupId="g1" onClose={jest.fn()} />);
  await fireEvent.press(getByText("Create challenge"));
  expect(getByText("Name your challenge.")).toBeTruthy();
  expect(mockMutate).not.toHaveBeenCalled();
});

test("submits title, selected metric and duration then navigates on success", async () => {
  mockMutate.mockImplementation((_vars, opts) => opts.onSuccess({ id: "c9" }));
  const onClose = jest.fn();
  const { getByText, getByPlaceholderText } = await render(<CreateChallengeSheet visible groupId="g1" onClose={onClose} />);
  await fireEvent.changeText(getByPlaceholderText("Challenge title"), "July streak");
  await fireEvent.press(getByText("Logged days")); // pick the "logged" metric
  await fireEvent.press(getByText("2 weeks")); // pick 2w
  await fireEvent.press(getByText("Create challenge"));
  expect(mockMutate).toHaveBeenCalledWith(
    { groupId: "g1", title: "July streak", metric: "logged", duration: "2w" },
    expect.any(Object),
  );
  expect(onClose).toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith("/challenge/c9");
});
