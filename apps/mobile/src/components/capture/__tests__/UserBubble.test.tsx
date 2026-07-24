import { render } from "@testing-library/react-native";
import { UserBubble } from "../UserBubble";

test("renders children", async () => {
  const { getByText } = await render(<UserBubble>Grilled chicken with rice</UserBubble>);
  expect(getByText("Grilled chicken with rice")).toBeTruthy();
});
