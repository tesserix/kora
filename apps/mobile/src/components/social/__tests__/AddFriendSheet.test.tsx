import { render, fireEvent } from "@testing-library/react-native";
import { AddFriendSheet } from "../AddFriendSheet";

const mockSendMutate = jest.fn();
jest.mock("@/api/hooks", () => ({
  useSendFriendRequest: () => ({ mutate: mockSendMutate, isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC123XY", link: "mobile://friend/ABC123XY" } }),
}));
beforeEach(() => mockSendMutate.mockClear());

test("submitting sends the entered code as the request body", async () => {
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={jest.fn()} />);
  await fireEvent.changeText(getByLabelText("Friend code or email"), "XYZ789AB");
  await fireEvent.press(getByText("Send request"));
  expect(mockSendMutate).toHaveBeenCalledWith(
    { code: "XYZ789AB" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("an input containing @ is sent as email", async () => {
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={jest.fn()} />);
  await fireEvent.changeText(getByLabelText("Friend code or email"), "pal@kora.app");
  await fireEvent.press(getByText("Send request"));
  expect(mockSendMutate).toHaveBeenCalledWith(
    { email: "pal@kora.app" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("shows my share code", async () => {
  const { getByText } = await render(<AddFriendSheet visible onClose={jest.fn()} />);
  expect(getByText("ABC123XY")).toBeTruthy();
});
