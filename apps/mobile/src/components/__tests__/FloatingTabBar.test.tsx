import { AccessibilityInfo } from "react-native";
import { render, fireEvent, waitFor } from "@testing-library/react-native";

import { router } from "expo-router";
import { useUnreadCount } from "@/api/hooks";
import { FloatingTabBar } from "@/components/FloatingTabBar";
import { instrumentLight } from "@/theme/palette";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({ useUnreadCount: jest.fn(() => ({ data: { count: 0 } })) }));

// Local override of jest.setup.js's expo-symbols mock, which drops every prop
// but the symbol name. The tab bar's active/inactive separation lives largely
// in the icon tint, so these tests need `tintColor` to survive into the tree.
jest.mock("expo-symbols", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SymbolView: (props: { name: string; tintColor?: string }) =>
      React.createElement(View, { testID: `sf-${props.name}`, tintColor: props.tintColor }),
  };
});

// Component tests render under the default (light) color scheme, so the
// instrument tokens asserted below are the light half of the table.
function flattenStyle(style: unknown): Record<string, unknown> {
  const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
  return Object.assign({}, ...flat.filter(Boolean));
}

const props = {
  state: { index: 0, routes: [{ key: "index", name: "index" }, { key: "diary", name: "diary" }, { key: "progress", name: "progress" }, { key: "more", name: "more" }] },
  navigation: { navigate: jest.fn(), emit: () => ({ defaultPrevented: false }) },
};

test("renders tab labels and a capture button", async () => {
  const { findByLabelText } = await render(<FloatingTabBar {...props} />);
  expect(await findByLabelText("Today")).toBeTruthy();
  expect(await findByLabelText("Capture")).toBeTruthy();
});

// Dock v2: labels are always on, not just the active tab. (Rendered text is
// the label as authored — visual uppercasing is `textTransform`, which RNTL's
// getByText does not apply, so this matches the literal TAB_META case.)
test("renders always-visible labels for every tab", async () => {
  const { getByText } = await render(<FloatingTabBar {...props} />);
  for (const l of ["Today", "Diary", "Trends", "More"]) expect(getByText(l)).toBeTruthy();
});

// Dock v2: a single sliding well replaces the old per-tab recessed pill.
test("renders a single sliding active well", async () => {
  const { getByTestId } = await render(<FloatingTabBar {...props} />);
  expect(getByTestId("dock-well")).toBeTruthy();
});

// Instrument Glass rename: Home -> Today, Progress -> Trends. The active tab's
// accent dot now lives on the shared sliding well (dock-well-dot), not per-tab.
test("the active tab carries the accent dot and tabs use the new names", async () => {
  const { getByText, queryByText, findByTestId } = await render(<FloatingTabBar {...props} />);
  expect(getByText("Today")).toBeTruthy();
  expect(getByText("Trends")).toBeTruthy();
  expect(queryByText("Progress")).toBeNull();
  expect(queryByText("Home")).toBeNull();
  expect(await findByTestId("dock-well-dot")).toBeTruthy();
});

test("capture button routes to /capture", async () => {
  const { findByLabelText } = await render(<FloatingTabBar {...props} />);
  fireEvent.press(await findByLabelText("Capture"));
  expect(router.push).toHaveBeenCalledWith("/capture");
});

test("tab press navigates to the tapped route", async () => {
  const navigate = jest.fn();
  const { findByLabelText } = await render(
    <FloatingTabBar {...props} navigation={{ ...props.navigation, navigate }} />,
  );
  fireEvent.press(await findByLabelText("Diary"));
  expect(navigate).toHaveBeenCalledWith("diary");
});

test("shows the active tint dot exactly once, on the sliding well", async () => {
  // getByTestId throws if more than one match exists, so this alone proves
  // the dot renders exactly once even though the well itself is shared.
  const { findByTestId } = await render(<FloatingTabBar {...props} />);
  expect(await findByTestId("dock-well-dot")).toBeTruthy();
});

test("shows an unread accent dot on More when count > 0", async () => {
  (useUnreadCount as jest.Mock).mockReturnValueOnce({ data: { count: 3 } });
  const { findByTestId } = await render(<FloatingTabBar {...props} />);
  expect(await findByTestId("more-unread-badge")).toBeTruthy();
});

test("hides the unread accent dot on More when count is 0", async () => {
  const { queryByTestId } = await render(<FloatingTabBar {...props} />);
  expect(queryByTestId("more-unread-badge")).toBeNull();
});

// Dock v2: the single sliding well (not a per-tab pill) marks the active tab,
// a full-pill dock-capsule silhouette painted in the recessed `inset` fill.
test("the sliding well is an inset full pill", async () => {
  const { findByTestId } = await render(<FloatingTabBar {...props} />);
  const flat = flattenStyle((await findByTestId("dock-well")).props.style);
  expect(flat.backgroundColor).toBe(instrumentLight.inset);
  expect(flat.height).toBe(44);
  expect(flat.borderRadius).toBe(22);
});

// Accent rule (hard, per spec): orange appears on ONE element per view. The
// well is deliberately neutral so the 4pt dot keeps being the only accent in
// the bar.
test("the well is neutral so the accent dot stays the bar's only accent element", async () => {
  const { findByTestId, getAllByTestId } = await render(<FloatingTabBar {...props} />);
  const well = flattenStyle((await findByTestId("dock-well")).props.style);
  expect(well.backgroundColor).not.toBe(instrumentLight.accent);
  const dot = flattenStyle((await findByTestId("dock-well-dot")).props.style);
  expect(dot.backgroundColor).toBe(instrumentLight.accent);
  expect(getAllByTestId("dock-well")).toHaveLength(1);
});

test("the active label is full-opacity ink and heavier than the demoted inactive labels", async () => {
  const { getByText } = await render(<FloatingTabBar {...props} />);
  const active = flattenStyle(getByText("Today").props.style);
  const inactive = flattenStyle(getByText("Diary").props.style);
  expect(active.color).toBe(instrumentLight.ink);
  expect(active.opacity).toBe(1);
  expect(inactive.color).toBe(instrumentLight.mut);
  expect(Number(inactive.opacity)).toBeLessThan(1);
  // Separation by weight as well as hue — at 9px, hue alone is not enough.
  expect(Number(active.fontWeight)).toBeGreaterThan(Number(inactive.fontWeight));
});

test("the active icon is tinted ink while inactive icons stay mut", async () => {
  const { getByTestId } = await render(<FloatingTabBar {...props} />);
  expect(getByTestId("sf-house.fill").props.tintColor).toBe(instrumentLight.ink);
  expect(getByTestId("sf-book.fill").props.tintColor).toBe(instrumentLight.mut);
  expect(getByTestId("sf-square.grid.2x2.fill").props.tintColor).toBe(instrumentLight.mut);
});

// A11y gate (spec: touch targets >= 44pt). The well must not have shrunk the
// tap area to its own painted bounds.
test("keeps every tab's touch target at 52pt", async () => {
  const { getByLabelText } = await render(<FloatingTabBar {...props} />);
  const flat = flattenStyle(getByLabelText("Today").props.style);
  expect(flat.width).toBe(52);
  expect(flat.height).toBe(52);
});

// I3: the tab bar's BlurView must honor Reduce Transparency, same as GlassPanel.
test("swaps the pill's BlurView for the opaque fallback when Reduce Transparency is on", async () => {
  jest.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled").mockResolvedValue(true);

  const { getByTestId, queryByTestId } = await render(<FloatingTabBar {...props} />);

  await waitFor(() => {
    expect(queryByTestId("tab-bar-pill-blur")).toBeNull();
  });
  expect(getByTestId("tab-bar-pill")).toBeTruthy();
  // The sliding well lives inside the pill's row, so it must survive the branch
  // swap — the fallback pill is opaque, not blurred, but still a glass surface.
  expect(getByTestId("dock-well")).toBeTruthy();

  jest.restoreAllMocks();
});

// kora#177: the pill was a HARD `height: 64` with `overflow: "hidden"` around a
// 9px label that scales with Dynamic Type. At 310% the label alone is ~28pt in
// a ~34pt box, so the content overflowed the pill and was clipped. The pill now
// grows, and the label — one of the few places a cap is legitimate — is capped.
// Dock v2 dropped the minHeight from 64 to 58 (the sliding well's own 44pt
// pill plus margin covers the visual weight the taller pill used to carry).
test("the pill grows instead of clipping at large Dynamic Type sizes", async () => {
  // Pinned explicitly: the reduce-transparency spy above swaps which of the two
  // pills renders, and restoreAllMocks does not put the default back.
  jest.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled").mockResolvedValue(false);
  const { getByTestId } = await render(<FloatingTabBar {...props} />);
  const pill = flattenStyle(getByTestId("tab-bar-pill-blur").props.style);
  expect(pill.height).toBeUndefined();
  expect(pill.minHeight).toBe(58);
});

test("the Reduce Transparency fallback pill grows too", async () => {
  jest.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled").mockResolvedValue(true);
  const { findByTestId } = await render(<FloatingTabBar {...props} />);
  const pill = flattenStyle((await findByTestId("tab-bar-pill")).props.style);
  expect(pill.height).toBeUndefined();
  expect(pill.minHeight).toBe(58);
  jest.restoreAllMocks();
});

test("caps the 9px tab label's Dynamic Type growth", async () => {
  const { getByText } = await render(<FloatingTabBar {...props} />);
  for (const label of ["Today", "Diary"]) {
    expect(getByText(label).props.maxFontSizeMultiplier).toBe(1.6);
  }
});
