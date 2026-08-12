import { fireEvent, render } from "@testing-library/react-native";
import { TickRuler } from "../TickRuler";

const base = {
  mode: "continuous" as const,
  min: 35,
  max: 180,
  step: 0.5,
  accessibilityLabel: "Current weight in kilograms",
  testID: "weight-ruler",
};

describe("TickRuler continuous mode", () => {
  it("exposes itself as an adjustable control carrying its formatted value", async () => {
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const ruler = getByTestId("weight-ruler");
    expect(ruler.props.accessibilityRole).toBe("adjustable");
    expect(ruler.props.accessibilityValue).toEqual({ text: "84" });
  });

  it("uses formatLabel for the accessibility value when given one", async () => {
    const { getByTestId } = await render(
      <TickRuler {...base} value={70} onChange={jest.fn()} formatLabel={(v) => `${v} kilograms`} />,
    );
    expect(getByTestId("weight-ruler").props.accessibilityValue).toEqual({
      text: "70 kilograms",
    });
  });

  it("increments by exactly one step on the accessibility increment action", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).toHaveBeenCalledWith(84.5);
  });

  it("decrements by exactly one step", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onChange).toHaveBeenCalledWith(83.5);
  });

  it("does not report a value past the top of the range", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={180} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report a value below the bottom of the range", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={35} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a tick for every major graduation in view", async () => {
    const { getAllByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    expect(getAllByTestId(/^weight-ruler-tick-/).length).toBeGreaterThan(0);
  });
});
