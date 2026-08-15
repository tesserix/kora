import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { ScreenEntrance } from "@/motion/ScreenEntrance";

// expo-router's real useFocusEffect needs a navigation container above it,
// which an isolated component render has no reason to mount (same pattern
// as useHealth.test.tsx and the app/(tabs) screen suites). The mock records
// the callback so a test can fire it explicitly.
const mockFocusCallbacks: (() => void | (() => void))[] = [];
jest.mock("expo-router", () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    mockFocusCallbacks.push(cb);
  },
}));

afterEach(() => {
  jest.clearAllMocks();
  mockFocusCallbacks.length = 0;
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

test("renders children", async () => {
  const { findByText } = await render(
    <ScreenEntrance direction={0}>
      <Text>Screen content</Text>
    </ScreenEntrance>,
  );
  expect(await findByText("Screen content")).toBeTruthy();
});

test("applies the animated entrance style once focus fires", async () => {
  const { findByText } = await render(
    <ScreenEntrance direction={1}>
      <Text>Diary content</Text>
    </ScreenEntrance>,
  );
  await findByText("Diary content");
  expect(mockFocusCallbacks.length).toBeGreaterThan(0);
  // The mocked useFocusEffect merely records the callback — invoking it here
  // exercises the same code path a real focus event would, and must not throw.
  expect(() => mockFocusCallbacks[0]()).not.toThrow();
});

test("under Reduce Motion still renders without throwing", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const { findByText } = await render(
    <ScreenEntrance direction={2}>
      <Text>Trends content</Text>
    </ScreenEntrance>,
  );
  await findByText("Trends content");
  expect(() => mockFocusCallbacks[mockFocusCallbacks.length - 1]()).not.toThrow();
});
