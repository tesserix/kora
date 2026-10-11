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

test("renders emphasis rather than printing markdown asterisks", async () => {
  const { getByText, queryByText } = await render(
    <OttoBubble>your daily target is **140g** of protein</OttoBubble>,
  );
  expect(queryByText(/\*\*/)).toBeNull();
  expect(getByText("140g")).toBeTruthy();
});

test("lays a bulleted plan out as separate lines", async () => {
  const { getByText, getAllByText } = await render(
    <OttoBubble>{"Day 1\n- Steak — 180g sirloin\n- Salad — greens"}</OttoBubble>,
  );
  expect(getByText("Day 1")).toBeTruthy();
  expect(getByText("Steak — 180g sirloin")).toBeTruthy();
  expect(getAllByText("•")).toHaveLength(2);
});
