import { Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { AuthScaffold } from "../AuthScaffold";

test("renders both body and footer content", async () => {
  const { getByText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getByText("Body")).toBeTruthy();
  expect(getByText("Continue")).toBeTruthy();
});

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown } | null;

function find(node: unknown, match: (n: Node) => boolean): Node {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }
  const n = node as Node;
  if (match(n)) return n;
  return find((n as { children?: unknown }).children, match);
}

const byTestId = (id: string) => (n: Node) => n?.props?.testID === id;

test("the footer is genuinely outside the scroll view, not merely styled apart", async () => {
  // The shipped screens put the primary action inline at the end of the scroll,
  // where a long form plus an open keyboard can push it out of reach. Asserting
  // the border alone would pass with the footer nested inside the ScrollView —
  // verified by mutation — so this checks containment structurally.
  const { getByTestId, toJSON } = await render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );

  const scroll = find(toJSON(), (n) => String(n?.type) === "RCTScrollView");
  expect(scroll).toBeTruthy();
  expect(find(scroll, byTestId("auth-scaffold-footer"))).toBeNull();

  const style = getByTestId("auth-scaffold-footer").props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
  expect(flat.borderTopWidth).toBe(1);
  expect(flat.borderTopColor).toBeTruthy();
});

test("no back control is rendered unless onBack is supplied", async () => {
  const { queryByLabelText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(queryByLabelText("Go back")).toBeNull();
});

test("progress without onBack renders the header but still no back control", async () => {
  // Isolates the inner `onBack ?` gate. The previous test cannot: with neither
  // prop the whole header is skipped, so the inner gate is unreachable and a
  // regression there would go unnoticed.
  const { queryByLabelText, getAllByTestId } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 1, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getAllByTestId("progress-dot")).toHaveLength(2);
  expect(queryByLabelText("Go back")).toBeNull();
});

test("onBack renders a labelled control and fires it", async () => {
  const onBack = jest.fn();
  const { getByLabelText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} onBack={onBack}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  fireEvent.press(getByLabelText("Go back"));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("progress renders one dot per step and announces the position", async () => {
  const { getAllByTestId, getByLabelText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 2, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getAllByTestId("progress-dot")).toHaveLength(2);
  expect(getByLabelText("Step 2 of 2")).toBeTruthy();
});

test("the current progress dot is visually distinct from the rest", async () => {
  const { getAllByTestId } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 1, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  const [first, second] = getAllByTestId("progress-dot").map((d) => d.props.style);
  expect(first.width).not.toBe(second.width);
  expect(first.backgroundColor).not.toBe(second.backgroundColor);
});
