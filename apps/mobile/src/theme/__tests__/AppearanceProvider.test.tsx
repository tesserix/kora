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

test("defaults to system and falls back to the device scheme when nothing is stored", async () => {
  const { result } = await renderHook(() => useAppearance(), { wrapper });

  expect(result.current.preference).toBe("system");
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("unspecified"));
});

test("hydrates a stored preference and applies it as the color scheme", async () => {
  await AsyncStorage.setItem(STORAGE_KEY, "dark");

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  await waitFor(() => expect(result.current.preference).toBe("dark"));
  expect(setColorScheme).toHaveBeenCalledWith("dark");
});

test("ignores a stored value that is not a known preference", async () => {
  await AsyncStorage.setItem(STORAGE_KEY, "sepia");

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("unspecified"));
  expect(result.current.preference).toBe("system");
});

test("setPreference persists the choice and applies the literal scheme", async () => {
  const { result } = await renderHook(() => useAppearance(), { wrapper });
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("unspecified"));

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

test("survives an AsyncStorage read rejection by staying on system", async () => {
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error("read failed"));

  const { result } = await renderHook(() => useAppearance(), { wrapper });

  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("unspecified"));
  expect(result.current.preference).toBe("system");
});

test("survives an AsyncStorage write rejection without losing the in-memory choice", async () => {
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("write failed"));
  const { result } = await renderHook(() => useAppearance(), { wrapper });
  await waitFor(() => expect(setColorScheme).toHaveBeenCalledWith("unspecified"));

  await act(async () => {
    result.current.setPreference("dark");
  });

  expect(result.current.preference).toBe("dark");
  expect(setColorScheme).toHaveBeenLastCalledWith("dark");
});

test("useAppearance without a provider returns a safe system default", async () => {
  const { result } = await renderHook(() => useAppearance());

  expect(result.current.preference).toBe("system");
  expect(() => result.current.setPreference("dark")).not.toThrow();
});
