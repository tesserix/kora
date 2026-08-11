import { instrumentDark, instrumentLight } from "../palette";

const KEYS = [
  "bg", "ink", "mut", "glass", "glassBorder", "glassHighlight",
  "inset", "hairline", "tick", "tickLit", "accent", "accentOn", "danger", "teal",
] as const;

test("both instrument themes define every token", () => {
  for (const k of KEYS) {
    expect(typeof instrumentDark[k]).toBe("string");
    expect(typeof instrumentLight[k]).toBe("string");
  }
});

test("the accent is signal orange in both themes and nothing is purple", () => {
  expect(instrumentDark.accent).toBe("#FF4A00");
  expect(instrumentLight.accent).toBe("#FF4A00");
  // the legacy purple sleepMetric must not leak into instrument tokens
  const all = [...Object.values(instrumentDark), ...Object.values(instrumentLight)];
  expect(all.some((v) => /7A6BFF|8B7CFF/i.test(v))).toBe(false);
});

test("grounds and ink swap between themes", () => {
  expect(instrumentDark.bg).toBe("#0B0D10");
  expect(instrumentLight.bg).toBe("#ECEDEF");
  expect(instrumentDark.ink).toBe("#EDE6D4");
  expect(instrumentLight.ink).toBe("#16181C");
});
