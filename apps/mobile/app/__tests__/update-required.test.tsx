import { fireEvent, render } from "@testing-library/react-native";
import { Linking } from "react-native";

import UpdateRequired from "../update-required";

test("sends the user to the store and offers no way back", async () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const ui = await render(<UpdateRequired />);

  expect(ui.getByText("This version of Kora is out of date")).toBeTruthy();
  expect(ui.queryByLabelText(/back/i)).toBeNull();

  fireEvent.press(ui.getByLabelText("Update Kora"));
  expect(open).toHaveBeenCalledWith("https://apps.apple.com/app/id6799465324");
  open.mockRestore();
});
