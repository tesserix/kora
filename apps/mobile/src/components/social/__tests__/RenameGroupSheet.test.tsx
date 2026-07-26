import { render, fireEvent } from "@testing-library/react-native";
import { RenameGroupSheet } from "../RenameGroupSheet";

const mockRename = jest.fn();
jest.mock("@/api/hooks", () => ({
  useRenameGroup: () => ({ mutate: mockRename, isPending: false }),
}));

beforeEach(() => mockRename.mockReset());

test("seeds the input with the current name and saves the trimmed value", async () => {
  const onClose = jest.fn();
  const { getByLabelText, getByText } = await render(
    <RenameGroupSheet visible groupId="g1" currentName="Old Crew" onClose={onClose} />,
  );
  const input = getByLabelText("Group name");
  expect(input.props.value).toBe("Old Crew");
  await fireEvent.changeText(input, "  New Crew  ");
  await fireEvent.press(getByText("Save"));
  expect(mockRename).toHaveBeenCalledWith({ groupId: "g1", name: "New Crew" }, expect.anything());
});

test("blank name shows an error and does not mutate", async () => {
  const { getByLabelText, getByText } = await render(
    <RenameGroupSheet visible groupId="g1" currentName="" onClose={jest.fn()} />,
  );
  await fireEvent.changeText(getByLabelText("Group name"), "   ");
  await fireEvent.press(getByText("Save"));
  expect(mockRename).not.toHaveBeenCalled();
  expect(getByText("Name your group.")).toBeTruthy();
});
