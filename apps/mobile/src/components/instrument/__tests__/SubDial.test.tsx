import { render } from "@testing-library/react-native";
import { processColor } from "react-native";
import { SubDial } from "../SubDial";
import { instrumentLight, instrumentDark } from "@/theme/palette";

function strokePayload(node: { props: { stroke: unknown } }): unknown {
  const stroke = node.props.stroke as { payload?: unknown } | string;
  return (stroke as { payload?: unknown })?.payload ?? stroke;
}

test("lights segments up to the fraction in accent", async () => {
  const { getByTestId } = await render(<SubDial fraction={0.5} testID="sub" />);
  // 25 segments, indices 0..24; 0.5 → segments 0..12 lit
  expect(getByTestId("sub-seg-0")).toBeTruthy();
  expect(getByTestId("sub-seg-24")).toBeTruthy();
  const lit = getByTestId("sub-seg-12").props.stroke;
  const unlit = getByTestId("sub-seg-13").props.stroke;
  const litPayload = (lit as { payload?: unknown })?.payload ?? lit;
  const unlitPayload = (unlit as { payload?: unknown })?.payload ?? unlit;
  expect(litPayload).not.toEqual(unlitPayload);
});

test("clamps out-of-range fractions", async () => {
  const { getByTestId } = await render(<SubDial fraction={1.7} testID="sub" />);
  expect(getByTestId("sub-seg-24").props.stroke).toEqual(getByTestId("sub-seg-0").props.stroke);
});

// spec 2026-08-16 accent budget: orange belongs to the hero needle alone —
// sub-dials (macro cells) light in ink (`tickLit`), not `accent`.
test("lit segments use tickLit, not accent", async () => {
  const { getByTestId } = await render(<SubDial fraction={0.5} testID="sub" />);
  const lit = strokePayload(getByTestId("sub-seg-0"));
  const tickLitPayloads = [processColor(instrumentLight.tickLit), processColor(instrumentDark.tickLit)];
  const accentPayloads = [processColor(instrumentLight.accent), processColor(instrumentDark.accent)];
  expect(tickLitPayloads).toContain(lit);
  expect(accentPayloads).not.toContain(lit);
});
