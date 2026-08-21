// kora#241. The diary derived a queued row's title and icon with two
// independent ternary chains whose last arm was "Voice note"/"mic", so every
// kind added after voice rendered as a voice note. This module replaced them
// with one exhaustive switch; these tests pin every arm, so a future arm that
// somehow reaches the fallthrough is a red test as well as a compile error.
import { captureRowPresentation } from "../captureRowPresentation";

const row = (over: Parameters<typeof captureRowPresentation>[0]) => over;

it("titles a text row with the user's own words", () => {
  expect(captureRowPresentation(row({ kind: "text", phrase: "two eggs", code: null })))
    .toEqual({ name: "two eggs", iconName: "message-circle" });
});

it("names a photo and a voice row for their modality", () => {
  expect(captureRowPresentation(row({ kind: "photo", phrase: null, code: null })))
    .toEqual({ name: "Photo", iconName: "camera" });
  expect(captureRowPresentation(row({ kind: "voice", phrase: null, code: null })))
    .toEqual({ name: "Voice note", iconName: "mic" });
});

// A raw EAN is not a meal name, and it is all this row has until it resolves.
it("gives a barcode row a stable label and the barcode icon", () => {
  expect(captureRowPresentation(row({ kind: "barcode", phrase: null, code: "5000112637922" })))
    .toEqual({ name: "Scanned item ending 7922", iconName: "barcode" });
});

// Two queued scans must not be two identical rows: the user cannot otherwise
// tell which is which, nor a duplicate from a second product.
it("distinguishes two queued codes", () => {
  const a = captureRowPresentation(row({ kind: "barcode", phrase: null, code: "5000112637922" }));
  const b = captureRowPresentation(row({ kind: "barcode", phrase: null, code: "8901030865278" }));
  expect(a.name).not.toEqual(b.name);
});

// A code shorter than the tail is shown whole rather than sliced to nothing.
// The scanner is configured for ean13/ean8/upc_a/upc_e, all of them longer
// than this, so it is a guard rather than a case the user reaches.
it("shows a short code whole", () => {
  expect(captureRowPresentation(row({ kind: "barcode", phrase: null, code: "12" })).name)
    .toBe("Scanned item ending 12");
});

// `code` is nullable because QueuedCaptureRow is one shape for every kind, not
// because a barcode row can lack one — captureQueue's isValid rejects an empty
// code. Still must not render "Scanned item ending null".
it("falls back to the bare label if a barcode row somehow has no code", () => {
  expect(captureRowPresentation(row({ kind: "barcode", phrase: null, code: null })).name)
    .toBe("Scanned item");
});

// The compiler is the real guard (the default arm assigns to `never`), but a
// row deserialised from storage is data, not a typed value — so the runtime
// throw is what stops a wrong label reaching the diary.
it("throws rather than mislabelling an unknown kind", () => {
  expect(() =>
    captureRowPresentation({ kind: "hologram", phrase: null, code: null } as never),
  ).toThrow(/unhandled capture kind/);
});
