import { render } from "@testing-library/react-native";
import { Sparkline } from "../Sparkline";

describe("Sparkline", () => {
  it("renders a polyline for >=2 points", async () => {
    const { getByTestId } = await render(<Sparkline points={[1, 3, 2, 4]} />);
    const line = getByTestId("sparkline");
    // react-native-svg converts points to a d path string (Mx1 y1 x2 y2 ...)
    expect(typeof line.props.d).toBe("string");
    // 4 points = Mx1 + 7 more coordinates = 8 space-separated elements
    expect(line.props.d.split(" ")).toHaveLength(8);
  });
  it("renders nothing for <2 points", async () => {
    const { queryByTestId } = await render(<Sparkline points={[5]} />);
    expect(queryByTestId("sparkline")).toBeNull();
  });
});
