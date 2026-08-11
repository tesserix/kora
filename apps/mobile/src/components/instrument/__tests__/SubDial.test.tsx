import { render } from "@testing-library/react-native";
import { SubDial } from "../SubDial";

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
