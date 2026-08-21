import { Text } from "react-native";
import { fireEvent, render, within } from "@testing-library/react-native";
import * as SafeAreaContext from "react-native-safe-area-context";
import { AuthScaffold } from "../AuthScaffold";

test("renders both body and footer content", async () => {
  const { getByText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getByText("Body")).toBeTruthy();
  expect(getByText("Continue")).toBeTruthy();
});

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown } | null;

function find(node: unknown, match: (n: Node) => boolean): Node {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }
  const n = node as Node;
  if (match(n)) return n;
  return find((n as { children?: unknown }).children, match);
}

const byTestId = (id: string) => (n: Node) => n?.props?.testID === id;

// jest's Dimensions default is fontScale 2, which is ABOVE the threshold — so
// every test that cares about the arrangement has to say which content size it
// means. Silence here is not "the default size", it is AX.
const spies: Array<{ mockRestore: () => void }> = [];

// Restores only the spies taken here. NOT jest.restoreAllMocks(): the safe-area
// mock installed in jest.setup.js is built from jest.fn()s, and `spyOn` over an
// existing mock hands back that same mock — so restoring it strips its
// implementation rather than putting anything back, and useSafeAreaInsets
// returns undefined from then on. The tests above already do that to it; the
// insets are therefore set explicitly below rather than assumed.
afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
});

function withInsets(top: number) {
  (SafeAreaContext.useSafeAreaInsets as unknown as jest.Mock).mockReturnValue({
    top,
    bottom: 0,
    left: 0,
    right: 0,
  });
}

function withFontScale(fontScale: number) {
  // require, not a top-level import: an ESM namespace object is sealed, so
  // jest.spyOn cannot redefine a property on it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require("react-native");
  const spy = jest
    .spyOn(rn, "useWindowDimensions")
    .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale });
  spies.push(spy);
  return spy;
}

// Depth-first testIDs, so "the header comes BEFORE the body" is an assertion
// about document order rather than about mere containment.
function testIdOrder(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) testIdOrder(child, out);
    return out;
  }
  const n = node as Node;
  const id = n?.props?.testID;
  if (typeof id === "string") out.push(id);
  return testIdOrder((n as { children?: unknown }).children, out);
}

const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style) as Record<
    string,
    unknown
  >;

test("the footer is genuinely outside the scroll view, not merely styled apart", async () => {
  // The shipped screens put the primary action inline at the end of the scroll,
  // where a long form plus an open keyboard can push it out of reach. Asserting
  // the border alone would pass with the footer nested inside the ScrollView —
  // verified by mutation — so this checks containment structurally.
  const { getByTestId, toJSON } = await render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );

  const scroll = find(toJSON(), (n) => String(n?.type) === "RCTScrollView");
  expect(scroll).toBeTruthy();
  expect(find(scroll, byTestId("auth-scaffold-footer"))).toBeNull();

  const style = getByTestId("auth-scaffold-footer").props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
  expect(flat.borderTopWidth).toBe(1);
  expect(flat.borderTopColor).toBeTruthy();
});

test("no back control is rendered unless onBack is supplied", async () => {
  const { queryByLabelText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(queryByLabelText("Go back")).toBeNull();
});

test("progress without onBack renders the header but still no back control", async () => {
  // Isolates the inner `onBack ?` gate. The previous test cannot: with neither
  // prop the whole header is skipped, so the inner gate is unreachable and a
  // regression there would go unnoticed.
  const { queryByLabelText, getAllByTestId } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 1, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getAllByTestId("progress-dot")).toHaveLength(2);
  expect(queryByLabelText("Go back")).toBeNull();
});

test("onBack renders a labelled control and fires it", async () => {
  const onBack = jest.fn();
  const { getByLabelText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} onBack={onBack}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  fireEvent.press(getByLabelText("Go back"));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("progress renders one dot per step and announces the position", async () => {
  const { getAllByTestId, getByLabelText } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 2, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getAllByTestId("progress-dot")).toHaveLength(2);
  expect(getByLabelText("Step 2 of 2")).toBeTruthy();
});

test("the current progress dot is visually distinct from the rest", async () => {
  const { getAllByTestId } = await render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 1, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  const [first, second] = getAllByTestId("progress-dot").map((d) => d.props.style);
  expect(first.width).not.toBe(second.width);
  expect(first.backgroundColor).not.toBe(second.backgroundColor);
});

describe("AuthScaffold header", () => {
  it("renders a header element when given one", async () => {
    const { getByTestId } = await render(
      <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
        <Text>Body</Text>
      </AuthScaffold>,
    );
    expect(getByTestId("pinned")).toBeTruthy();
  });

  it("keeps the header outside the scroll view at the default content size", async () => {
    const spy = withFontScale(1);
    const { getByTestId, queryByTestId } = await render(
      <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
        <Text testID="body">Body</Text>
      </AuthScaffold>,
    );
    const scroll = getByTestId("auth-scaffold-scroll");
    expect(within(scroll).queryByTestId("pinned")).toBeNull();
    expect(within(scroll).getByTestId("body")).toBeTruthy();
    spy.mockRestore();
  });

  it("still renders without a header", async () => {
    const { getByTestId } = await render(
      <AuthScaffold footer={<Text>Go</Text>}>
        <Text testID="body">Body</Text>
      </AuthScaffold>,
    );
    expect(getByTestId("body")).toBeTruthy();
  });

  it("applies top safe-area inset to header when no nav row is present", async () => {
    // The onboarding screen uses header without onBack or progress — this is the
    // critical configuration on notched devices. The header wrapper must take the
    // top inset to avoid rendering under the notch.
    const useSafeAreaInsetsSpy = jest.spyOn(SafeAreaContext, "useSafeAreaInsets");
    useSafeAreaInsetsSpy.mockReturnValue({ top: 44, bottom: 0, left: 0, right: 0 });

    try {
      const { getByTestId } = await render(
        <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
          <Text>Body</Text>
        </AuthScaffold>,
      );

      const headerWrapper = getByTestId("auth-scaffold-header-wrapper");
      const style = headerWrapper.props.style;
      const flatStyle = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
      expect(flatStyle.paddingTop).toBe(44);
    } finally {
      useSafeAreaInsetsSpy.mockRestore();
    }
  });

  it("scroll padding accounts for header already taking the inset", async () => {
    const fontScaleSpy = withFontScale(1);
    // When header is present and no nav row, the header wrapper consumes the inset.
    // The scroll must NOT add it again — instead use spacing.md for the gap below the header.
    // This test pins that exactly one of the two takes the inset, not both.
    const useSafeAreaInsetsSpy = jest.spyOn(SafeAreaContext, "useSafeAreaInsets");
    useSafeAreaInsetsSpy.mockReturnValue({ top: 44, bottom: 0, left: 0, right: 0 });

    try {
      const { getByTestId } = await render(
        <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
          <Text>Body</Text>
        </AuthScaffold>,
      );

      // Header wrapper must take the inset
      const headerWrapper = getByTestId("auth-scaffold-header-wrapper");
      const headerStyle = headerWrapper.props.style;
      const flatHeaderStyle = Array.isArray(headerStyle)
        ? Object.assign({}, ...headerStyle.filter(Boolean))
        : headerStyle;
      expect(flatHeaderStyle.paddingTop).toBe(44);

      // Scroll content padding must NOT include the inset when header is present
      const scroll = getByTestId("auth-scaffold-scroll");
      const scrollContentStyle = scroll.props.contentContainerStyle;
      const flatScrollStyle = Array.isArray(scrollContentStyle)
        ? Object.assign({}, ...scrollContentStyle.filter(Boolean))
        : scrollContentStyle;
      // Should be spacing.md, not insets.top + spacing.xl
      expect(flatScrollStyle.paddingTop).toBe(16); // spacing.md from theme
    } finally {
      useSafeAreaInsetsSpy.mockRestore();
      fontScaleSpy.mockRestore();
    }
  });
});

// kora#284. At accessibility-extra-large the onboarding scroll region reached
// only "Age": the rulers — the controls — were all below the fold under a
// sticky header made of a dial and two captions that had doubled in height.
// Past the threshold the header stops being pinned and scrolls with the body.
//
// What these tests CANNOT show: that the rulers are now above the fold. Jest
// does no layout, so nothing here measures a single point of height. kora#257
// is the standing reminder — a clipped-ruler regression shipped past 1,729
// green tests. These pin the STRUCTURE the fix turns on, and the structure is
// all they pin.
describe("header placement above accessibility text sizes (kora#284)", () => {
  beforeEach(() => {
    withInsets(0);
  });

  const scaffold = (
    <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
      <Text testID="body">Body</Text>
    </AuthScaffold>
  );

  it("keeps the header a sibling above the scroll view at the threshold itself", async () => {
    // `>`, not `>=`: 1.3 is the last size that behaves exactly as it always has.
    withFontScale(1.3);
    const { getByTestId } = await render(scaffold);
    expect(within(getByTestId("auth-scaffold-scroll")).queryByTestId("pinned")).toBeNull();
  });

  it("moves the header inside the scroll view just past the threshold", async () => {
    withFontScale(1.31);
    const { getByTestId } = await render(scaffold);
    expect(within(getByTestId("auth-scaffold-scroll")).getByTestId("pinned")).toBeTruthy();
  });

  it("puts the scrolling header BEFORE the body, not after it", async () => {
    withFontScale(2.643);
    const { toJSON } = await render(scaffold);
    const order = testIdOrder(find(toJSON(), byTestId("auth-scaffold-scroll")));
    expect(order.indexOf("auth-scaffold-header-wrapper")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("auth-scaffold-header-wrapper")).toBeLessThan(order.indexOf("body"));
  });

  it("does not inset the scrolling header twice, horizontally or vertically", async () => {
    // The wrapper still owns the top inset, so the content container must add
    // none; and it cancels the content container's horizontal padding, so the
    // header keeps the same full-width box it has as a sibling. PlanDial sizes
    // itself against exactly one spacing.lg per side, so a second one would
    // draw the dial wider than the space it sits in.
    withInsets(59);
    withFontScale(2.643);

    const { getByTestId } = await render(scaffold);
    expect(flatten(getByTestId("auth-scaffold-header-wrapper").props.style).paddingTop).toBe(59);
    expect(flatten(getByTestId("auth-scaffold-header-wrapper").props.style).marginHorizontal).toBe(
      -24,
    );
    expect(
      flatten(getByTestId("auth-scaffold-scroll").props.contentContainerStyle).paddingTop,
    ).toBe(0);
  });

  it("renders the headerless sign-in path identically at every content size", async () => {
    // AuthScaffold is shared with sign-in, which passes no header. The move is
    // gated on `header` as well as the scale, so there must be no content size
    // at which that screen's tree differs — this compares the whole tree rather
    // than a chosen property, so a stray style change fails it too.
    const headerless = (
      <AuthScaffold footer={<Text>Continue</Text>}>
        <Text testID="body">Body</Text>
      </AuthScaffold>
    );

    const atDefault = withFontScale(1);
    const before = (await render(headerless)).toJSON();
    atDefault.mockRestore();

    for (const scale of [1.3, 1.31, 2.643, 3.571]) {
      const spy = withFontScale(scale);
      expect((await render(headerless)).toJSON()).toEqual(before);
      spy.mockRestore();
    }
  });
});
