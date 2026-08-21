import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SplashScreen from "expo-splash-screen";
import { AppearanceProvider, useAppearance } from "../AppearanceProvider";

// expo-splash-screen's exports are non-configurable, so jest.spyOn cannot
// patch them ("Cannot redefine property: hideAsync"). Mock the module instead.
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

const STORAGE_KEY = "kora.appearance";

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppearanceProvider>{children}</AppearanceProvider>
);

let setColorScheme: jest.SpyInstance;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  setColorScheme = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
});

afterEach(() => {
  setColorScheme.mockRestore();
});

test("applies dark synchronously on mount, before the AsyncStorage read resolves", async () => {
  // Stored preference is "light", but the initial render must already have
  // forced dark — proving the sync default runs ahead of hydration rather
  // than racing it.
  await AsyncStorage.setItem(STORAGE_KEY, "light");
  let resolveGetItem: (value: string | null) => void = () => {};
  (AsyncStorage.getItem as jest.Mock).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveGetItem = resolve;
    }),
  );

  await renderHook(() => useAppearance(), { wrapper });

  expect(setColorScheme).toHaveBeenCalledWith("dark");

  await act(async () => {
    resolveGetItem("light");
  });
  await waitFor(() => expect(setColorScheme).toHaveBeenLastCalledWith("light"));
});

test("defaults to dark when nothing is stored", async () => {
  const { result } = await renderHook(() => useAppearance(), { wrapper });

  expect(result.current.preference).toBe("dark");
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("dark"));
});

test("hydrates a stored preference and applies it as the color scheme", async () => {
  await AsyncStorage.setItem(STORAGE_KEY, "light");

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  await waitFor(() => expect(result.current.preference).toBe("light"));
  expect(setColorScheme).toHaveBeenCalledWith("light");
});

test("hydrates an explicit system preference and follows the device scheme", async () => {
  await AsyncStorage.setItem(STORAGE_KEY, "system");

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  await waitFor(() => expect(result.current.preference).toBe("system"));
  expect(setColorScheme).toHaveBeenCalledWith("unspecified");
});

test("ignores a stored value that is not a known preference and falls back to dark", async () => {
  await AsyncStorage.setItem(STORAGE_KEY, "sepia");

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("dark"));
  expect(result.current.preference).toBe("dark");
});

test("setPreference persists the choice and applies the literal scheme", async () => {
  const { result } = await renderHook(() => useAppearance(), { wrapper });
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("dark"));

  await act(async () => {
    result.current.setPreference("light");
  });

  expect(result.current.preference).toBe("light");
  expect(setColorScheme).toHaveBeenLastCalledWith("light");
  await waitFor(async () => expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe("light"));
});

test("returning to system persists system and hands the scheme back to the device", async () => {
  await AsyncStorage.setItem(STORAGE_KEY, "dark");
  const { result } = await renderHook(() => useAppearance(), { wrapper });
  await waitFor(() => expect(result.current.preference).toBe("dark"));

  await act(async () => {
    result.current.setPreference("system");
  });

  expect(result.current.preference).toBe("system");
  expect(setColorScheme).toHaveBeenLastCalledWith("unspecified");
  await waitFor(async () => expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe("system"));
});

test("survives an AsyncStorage read rejection by landing on dark", async () => {
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error("read failed"));

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  // NOT `toHaveBeenCalledWith("dark")`, which this test used to assert: the
  // lazy initializer already applied dark synchronously at mount (the test at
  // the top of this file is what proves that ordering), so that assertion is
  // satisfied before the read is even issued — deleting the catch branch's
  // applyPreference entirely would leave it green. The claim here is that the
  // REJECTION path re-asserts dark, so wait for its own call and pin the whole
  // sequence: mount, then the catch, and nothing that is not dark.
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledTimes(2));
  expect(setColorScheme.mock.calls).toEqual([["dark"], ["dark"]]);
  expect(result.current.preference).toBe("dark");
});

test("survives an AsyncStorage write rejection without losing the in-memory choice", async () => {
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("write failed"));
  const { result } = await renderHook(() => useAppearance(), { wrapper });
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("dark"));

  await act(async () => {
    result.current.setPreference("light");
  });

  expect(result.current.preference).toBe("light");
  expect(setColorScheme).toHaveBeenLastCalledWith("light");
});

test("useAppearance without a provider returns a safe dark default", async () => {
  const { result } = await renderHook(() => useAppearance());

  expect(result.current.preference).toBe("dark");
  expect(() => result.current.setPreference("dark")).not.toThrow();
});

// kora#320. The scheme cannot be known on first render — the preference is in
// AsyncStorage — so kora#139 applies dark synchronously and corrects itself
// after hydration. For anyone who chose Light that correction WAS the flash.
// It is now made behind the native splash, which means the splash must come
// down on every path out of hydration. Being stranded on a splash forever is
// far worse than a flash, so each exit is pinned separately.
describe("splash hand-off", () => {
  const hideAsync = SplashScreen.hideAsync as jest.Mock;

  beforeEach(() => {
    hideAsync.mockClear();
  });

  test("reveals the app once the stored preference has been applied", async () => {
    await AsyncStorage.setItem(STORAGE_KEY, "light");
    renderHook(() => useAppearance(), { wrapper });
    await waitFor(() => expect(hideAsync).toHaveBeenCalled());
  });

  test("reveals the app even when the storage read REJECTS", async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error("storage unavailable"));
    renderHook(() => useAppearance(), { wrapper });
    // The catch branch falls back to dark; what matters here is that it still
    // lets go of the splash rather than leaving an unusable app on screen.
    await waitFor(() => expect(hideAsync).toHaveBeenCalled());
  });

  // Hydration, the backstop and unmount all call reveal(); it must be
  // idempotent, or a late path fires hideAsync against an already-hidden
  // splash. Unmount is the cheapest of the three to drive deterministically.
  test("reveals exactly once, however many paths call it", async () => {
    await AsyncStorage.setItem(STORAGE_KEY, "dark");
    const { unmount } = await renderHook(() => useAppearance(), { wrapper });
    await waitFor(() => expect(hideAsync).toHaveBeenCalled());
    unmount();
    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  // A rejection is handled by the .catch/.finally above; a promise that never
  // SETTLES is not, and has no upper bound — that is all the backstop covers.
  //
  // Pinned by asserting the timer is scheduled rather than by advancing fake
  // timers: renderHook is async in this RTL, so the mount effect (and with it
  // the setTimeout) does not exist yet when a synchronous advance would run,
  // and flushing it first under fake timers is exactly the overlapping-act
  // trap documented elsewhere in this repo. What matters is that a bounded
  // fallback is armed at all; that clearTimeout cancels it on the happy path
  // is covered by the "reveals exactly once" test below.
  test("arms a bounded fallback in case the storage read never settles", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    (AsyncStorage.getItem as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
    renderHook(() => useAppearance(), { wrapper });
    await waitFor(() =>
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000),
    );
    expect(hideAsync).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
