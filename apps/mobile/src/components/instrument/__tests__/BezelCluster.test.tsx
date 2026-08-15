import { StyleSheet, Text } from "react-native";
import { render } from "@testing-library/react-native";
import { BezelCluster, ZoneRule, WellFooter } from "../BezelCluster";
import { SpecularSweep } from "../SpecularSweep";
import { instrumentLight } from "@/theme/palette";

// Light scheme is the test environment's default (no useColorScheme mock) —
// same convention as GlassPanel.test.tsx.
describe("BezelCluster", () => {
  it("renders children inside a rimmed glass body", async () => {
    const { getByText, getByTestId } = await render(
      <BezelCluster testID="hero"><Text>gauge</Text></BezelCluster>,
    );
    expect(getByText("gauge")).toBeTruthy();
    expect(getByTestId("hero-rim")).toBeTruthy();
  });

  it("ZoneRule renders an uppercase engraved label", async () => {
    const { getByText } = await render(<ZoneRule label="Macros" />);
    expect(getByText("MACROS")).toBeTruthy();
  });

  it("WellFooter paints the recessed inset fill matching instrument.inset", async () => {
    const { getByTestId } = await render(
      <WellFooter testID="well"><Text>water</Text></WellFooter>,
    );
    const style = StyleSheet.flatten(getByTestId("well").props.style);
    expect(style.backgroundColor).toBe(instrumentLight.inset);
  });
});

describe("SpecularSweep", () => {
  it("renders without crashing", async () => {
    const { toJSON } = await render(<SpecularSweep />);
    expect(toJSON()).toBeTruthy();
  });
});
