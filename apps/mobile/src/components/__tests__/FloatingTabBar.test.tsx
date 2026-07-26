import { render, fireEvent } from "@testing-library/react-native";

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
  expect(await findByLabelText("Home")).toBeTruthy();
  expect(await findByLabelText("Capture")).toBeTruthy();
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
  const { findByTestId, queryByTestId } = await render(<FloatingTabBar {...props} />);
  expect(await findByTestId("index-active-dot")).toBeTruthy();
  expect(queryByTestId("diary-active-dot")).toBeNull();
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
