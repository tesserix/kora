import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { AppText } from "../Text";
import { Button } from "../Button";
import { Card } from "../Card";

test("AppText renders children with variant", async () => {
  const { getByText } = await render(<AppText variant="h1">Kora</AppText>);
  expect(getByText("Kora")).toBeTruthy();
});

test("Button fires onPress and exposes accessibility role", async () => {
  const onPress = jest.fn();
  const { getByRole } = await render(<Button title="Log meal" onPress={onPress} />);
  fireEvent.press(getByRole("button"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("Button does not fire when disabled", async () => {
  const onPress = jest.fn();
  const { getByRole } = await render(<Button title="Log" onPress={onPress} disabled />);
  fireEvent.press(getByRole("button"));
  expect(onPress).not.toHaveBeenCalled();
});

test("Card renders children", async () => {
  const { getByText } = await render(
    <Card>
      <Text>inside</Text>
    </Card>
  );
  expect(getByText("inside")).toBeTruthy();
});

describe("Card variants", () => {
  it("defaults to flat (no shadow) and renders children", async () => {
    const { getByText, getByTestId } = await render(
      <Card testID="flatcard">
        <Text>hi</Text>
      </Card>
    );
    expect(getByText("hi")).toBeTruthy();
    const flat = getByTestId("flatcard");
    const style = Array.isArray(flat.props.style) ? Object.assign({}, ...flat.props.style) : flat.props.style;
    expect(style.shadowRadius).toBeFalsy();
  });
  it("elevated variant applies a shadow", async () => {
    const { getByTestId } = await render(<Card variant="elevated" testID="c"><Text>x</Text></Card>);
    const flat = getByTestId("c");
    const style = Array.isArray(flat.props.style) ? Object.assign({}, ...flat.props.style) : flat.props.style;
    expect(style.shadowRadius).toBeGreaterThan(0);
  });
});
