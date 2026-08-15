import { renderHook, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useDailyIgnition } from "../useDailyIgnition";

it("fires once per day", async () => {
  const first = await renderHook(() => useDailyIgnition("2026-08-16"));
  await waitFor(() => expect(first.result.current).toBe(true));
  const second = await renderHook(() => useDailyIgnition("2026-08-16"));
  await waitFor(() => expect(second.result.current).toBe(false));
});

it("fires again on a new day", async () => {
  await AsyncStorage.setItem("kora.ignition.lastPlayed", "2026-08-15");
  const { result } = await renderHook(() => useDailyIgnition("2026-08-16"));
  await waitFor(() => expect(result.current).toBe(true));
});

it("does not fire when reduced motion is on", async () => {
  const { result } = await renderHook(() => useDailyIgnition("2026-08-16", true));
  await new Promise((r) => setTimeout(r, 0));
  expect(result.current).toBe(false);
});
