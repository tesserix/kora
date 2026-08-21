import { StyleSheet } from "react-native";
import { render } from "@testing-library/react-native";
import { Avatar } from "../Avatar";

// kora#324. The circle is a fixed `size`; the glyph inside it was uncapped, so
// at accessibility text sizes the letter outgrew its own container — at AX5 a
// 15.2pt initial renders near 53pt inside a 40pt circle and spills out of the
// avatar, and on Home off the right edge of the screen.
//
// These pin the RATIO rather than any point value, because that is what makes
// the fix hold at every call site (32 in friends, 40 on Home, 72 on profile
// and more) without a per-size number.
describe("Avatar", () => {
  it("authors the initial at 38% of the circle, at every size", async () => {
    for (const size of [32, 40, 72]) {
      const { getByText } = await render(<Avatar initials="MS" size={size} />);
      // AppText composes its style into an array; flatten before reading it.
      const flat = StyleSheet.flatten(getByText("MS").props.style);
      expect(flat.fontSize).toBeCloseTo(size * 0.38, 5);
    }
  });

  it("caps the initial so it cannot outgrow the circle that holds it", async () => {
    const { getByText } = await render(<Avatar initials="MS" />);
    const { fontSize } = StyleSheet.flatten(getByText("MS").props.style);
    const cap = getByText("MS").props.maxFontSizeMultiplier;
    // The whole point: the largest the glyph can ever render must still fit
    // inside a circle of `size`. 0.58 is the widest ratio that clears the edge.
    expect(fontSize * cap).toBeLessThanOrEqual(40 * 0.58 + 0.001);
  });

  it("uses one cap for every size, since the constraint is a ratio", async () => {
    const caps = [];
    for (const size of [32, 40, 72]) {
      const { getByText } = await render(<Avatar initials="MS" size={size} />);
      caps.push(getByText("MS").props.maxFontSizeMultiplier);
    }
    expect(new Set(caps).size).toBe(1);
  });

  // Not capped to 1: the initial should still respond to Dynamic Type, it just
  // must not escape. A fix that froze it entirely would also pass the overflow
  // test above, so this pins the half of the trade that test cannot see.
  it("still grows with Dynamic Type rather than being frozen", async () => {
    const { getByText } = await render(<Avatar initials="MS" />);
    expect(getByText("MS").props.maxFontSizeMultiplier).toBeGreaterThan(1.2);
  });
});
