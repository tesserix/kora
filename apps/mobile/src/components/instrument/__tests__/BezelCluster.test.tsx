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

  // Review fix (kora ignition Task 7): a slot's kcal subtotal has to stay
  // mono/tabular-nums, not inherit the label's plain engraved sans — that
  // regressed when the two were merged into one ZoneRule label string.
  it("ZoneRule renders an optional detail in mono/tabular-nums, uppercased", async () => {
    const { getByText } = await render(<ZoneRule label="breakfast" detail="· 380 kcal" />);
    const detailStyle = StyleSheet.flatten(getByText("· 380 KCAL").props.style);
    expect(detailStyle.fontVariant).toContain("tabular-nums");
  });

  it("ZoneRule with no detail renders only the label, unaffected", async () => {
    const { getByText, queryByText } = await render(<ZoneRule label="Macros" />);
    expect(getByText("MACROS")).toBeTruthy();
    expect(queryByText(/·/)).toBeNull();
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

// The accent budget, pinned. Spec 2026-08-16: "one hero orange moment per
// screen + dock chrome", and a full-panel halo is not that moment — it wraps
// the hero and competes with it.
//
// Reported on device: "reduce or remove the orange glow outside the panel or
// use different color which contrast?". The glow is kept, because it lifts the
// cluster off the ground, but it is now a warm-ink backlight rather than accent.
test("the cluster's glow is a backlight, never the accent colour", async () => {
  const { getByTestId } = await render(
    <BezelCluster glow testID="hero">
      <Text>gauge</Text>
    </BezelCluster>,
  );

  const style = StyleSheet.flatten(getByTestId("hero").props.style);
  expect(style.shadowColor).toBe(instrumentLight.ink);
  expect(style.shadowColor).not.toBe(instrumentLight.accent);
});

test("without glow the cluster casts no coloured shadow of its own", async () => {
  const { getByTestId } = await render(
    <BezelCluster testID="plain">
      <Text>gauge</Text>
    </BezelCluster>,
  );

  const style = StyleSheet.flatten(getByTestId("plain").props.style) ?? {};
  expect(style.shadowColor).toBeUndefined();
});
