import { AccessibilityInfo } from "react-native";
import { render, fireEvent, waitFor } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({ useUnreadCount: jest.fn(() => ({ data: { count: 0 } })) }));

import { router } from "expo-router";
import { useUnreadCount } from "@/api/hooks";
import { FloatingTabBar } from "@/components/FloatingTabBar";

const props = {
  state: { index: 0, routes: [{ key: "index", name: "index" }, { key: "diary", name: "diary" }, { key: "progress", name: "progress" }, { key: "more", name: "more" }] },
  navigation: { navigate: jest.fn(), emit: () => ({ defaultPrevented: false }) },
};

test("renders tab labels and a capture button", async () => {
  const { findByLabelText } = await render(<FloatingTabBar {...props} />);
  expect(await findByLabelText("Today")).toBeTruthy();
  expect(await findByLabelText("Capture")).toBeTruthy();
});

// Instrument Glass rename: Home -> Today, Progress -> Trends. The active tab
// (index, per `props` above) carries a shared accent-dot testID rather than a
// per-route one, since only one tab is ever active at a time.
test("the active tab carries the accent dot and tabs use the new names", async () => {
  const { getByText, queryByText, findByTestId } = await render(<FloatingTabBar {...props} />);
  expect(getByText("Today")).toBeTruthy();
  expect(getByText("Trends")).toBeTruthy();
  expect(queryByText("Progress")).toBeNull();
  expect(queryByText("Home")).toBeNull();
  expect(await findByTestId("tab-dot-active")).toBeTruthy();
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

test("shows the active tint dot only on the currently active tab", async () => {
  // getByTestId throws if more than one match exists, so this alone proves
  // the dot renders exactly once even though every tab shares the testID.
  const { findByTestId } = await render(<FloatingTabBar {...props} />);
  expect(await findByTestId("tab-dot-active")).toBeTruthy();
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

// I3: the tab bar's BlurView must honor Reduce Transparency, same as GlassPanel.
test("swaps the pill's BlurView for the opaque fallback when Reduce Transparency is on", async () => {
  jest.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled").mockResolvedValue(true);

  const { getByTestId, queryByTestId } = await render(<FloatingTabBar {...props} />);

  await waitFor(() => {
    expect(queryByTestId("tab-bar-pill-blur")).toBeNull();
  });
  expect(getByTestId("tab-bar-pill")).toBeTruthy();

  jest.restoreAllMocks();
});
