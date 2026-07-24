import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { OttoBubble } from "../OttoBubble";

test("renders children", async () => {
  const { getByText } = await render(
    <OttoBubble>
      <Text>Hi Alex</Text>
    </OttoBubble>,
  );
  expect(getByText("Hi Alex")).toBeTruthy();
});

test("renders plain string children", async () => {
  const { getByText } = await render(<OttoBubble>Hi Alex</OttoBubble>);
  expect(getByText("Hi Alex")).toBeTruthy();
});
