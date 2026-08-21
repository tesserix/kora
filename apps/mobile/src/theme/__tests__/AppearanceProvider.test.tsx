import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppearanceProvider, useAppearance } from "../AppearanceProvider";

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
