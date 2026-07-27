import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { GaugeRing } from "../GaugeRing";

const circ = (size: number, stroke: number) => 2 * Math.PI * ((size - stroke) / 2);

describe("GaugeRing", () => {
  it("renders children centered", async () => {
    const { getByText } = await render(
      <GaugeRing value={50} max={100}><Text>1,200</Text></GaugeRing>,
    );
    expect(getByText("1,200")).toBeTruthy();
  });

  it("half-full arc offsets by half the circumference", async () => {
    const size = 72, stroke = 8;
    const { getByTestId } = await render(<GaugeRing value={50} max={100} size={size} stroke={stroke} />);
    const arc = getByTestId("gauge-arc");
    expect(arc.props.strokeDashoffset).toBeCloseTo(circ(size, stroke) * 0.5, 1);
  });

  it("max<=0 renders an empty arc (fully offset)", async () => {
    const size = 72, stroke = 8;
    const { getByTestId } = await render(<GaugeRing value={5} max={0} size={size} stroke={stroke} />);
    const arc = getByTestId("gauge-arc");
    expect(arc.props.strokeDashoffset).toBeCloseTo(circ(size, stroke), 1);
  });

  it("uses a gradient stroke when a gradient pair is provided", async () => {
    const { getByTestId } = await render(
      <GaugeRing value={50} max={100} gradient={["#3DDC6E", "#12A150"]} />,
    );
    // arc stroke references the gradient def (react-native-svg uses brushRef for gradients)
    const strokeProp = getByTestId("gauge-arc").props.stroke;
    expect(typeof strokeProp === "object" && strokeProp.brushRef).toBeTruthy();
  });
});
