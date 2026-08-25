import { StyleSheet } from "react-native";
import { act, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import { Avatar } from "../Avatar";

// This repo's testing-library build has no UNSAFE_getByType/UNSAFE_queryAllByType —
// its TestInstance only exposes host element types as strings via `.type` and a
// `queryAll(predicate)` walker, so component-type queries go through this instead.
function queryImages(container: TestInstance): TestInstance[] {
  return container.queryAll((instance) => instance.type === "Image");
}

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

  it("renders initials when there is no picture", async () => {
    const { getByText, container } = await render(<Avatar initials="AL" />);
    expect(getByText("AL")).toBeTruthy();
    expect(queryImages(container)).toHaveLength(0);
  });

  // An empty string is what the API sends for "no picture" — it is not a URL,
  // and rendering it produces a broken image inside a friend row.
  it("falls back to initials for an empty uri", async () => {
    const { getByText, container } = await render(<Avatar initials="AL" uri="" />);
    expect(getByText("AL")).toBeTruthy();
    expect(queryImages(container)).toHaveLength(0);
  });

  it("falls back to initials for a null uri", async () => {
    const { getByText } = await render(<Avatar initials="AL" uri={null} />);
    expect(getByText("AL")).toBeTruthy();
  });

  it("renders the picture when there is one, and not the initials underneath", async () => {
    const { queryByText, container } = await render(
      <Avatar initials="AL" uri="https://assets.test/avatars/a/v1.jpg" />,
    );
    const images = queryImages(container);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({ uri: "https://assets.test/avatars/a/v1.jpg" });
    expect(queryByText("AL")).toBeNull();
  });

  // The circle is the identity chip's whole shape. A square photo inside it
  // would break every row it appears in.
  it("clips the picture to the circle at the requested size", async () => {
    const { container } = await render(
      <Avatar initials="AL" size={72} uri="https://assets.test/a.jpg" />,
    );
    const style = StyleSheet.flatten(queryImages(container)[0].props.style);
    expect(style).toMatchObject({ width: 72, height: 72, borderRadius: 36 });
  });

  // kora#449 task 15 finding 2: a 404, a deleted object with a stale
  // avatar_url, or a transient CDN blip left the circle permanently blank —
  // strictly worse than the no-picture case, since the initials fallback
  // never triggered. onError must hand control back to the initials branch.
  it("falls back to initials when the image fails to load", async () => {
    const { getByText, queryByText, container } = await render(
      <Avatar initials="AL" uri="https://assets.test/broken.jpg" />,
    );
    expect(queryImages(container)).toHaveLength(1);
    expect(queryByText("AL")).toBeNull();

    const [image] = queryImages(container);
    await act(async () => {
      image.props.onError();
    });

    expect(getByText("AL")).toBeTruthy();
    expect(queryImages(container)).toHaveLength(0);
  });
});
