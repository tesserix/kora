import { renderHook } from "@testing-library/react-native";
import { useTheme } from "@/theme";

test("theme exposes a mono font family and shadow presets", async () => {
  const { result } = await renderHook(() => useTheme());
  expect(typeof result.current.fonts.mono).toBe("string");
  expect(result.current.fonts.mono.length).toBeGreaterThan(0);
  expect(result.current.shadows.sm.shadowRadius).toBeGreaterThan(0);
  expect(result.current.shadows.lg.elevation).toBeGreaterThan(result.current.shadows.sm.elevation);
});
