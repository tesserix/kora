import type { QueuedCaptureRow } from "./useQueuedCaptures";

// How a queued capture is named and iconed in the diary, before anything has
// identified it.
//
// It lives here, as an exhaustive switch, because the diary derived both with a
// fallthrough ternary chain (`... : c.kind === "photo" ? "Photo" : "Voice
// note"`, and an `iconName` that fell through to "mic" the same way). Every
// arm added after voice therefore rendered AS a voice note — the right label
// for exactly one kind and a lie for every future one — and no test could
// catch it, because "Voice note" is a perfectly valid string. kora#241's
// barcode arm would have been the first casualty. `never` in the default turns
// the next arm into a compile error instead of a wrong row.

/** Row title and icon. `name` is also what the row's accessibility label reads. */
export type CaptureRowPresentation = { name: string; iconName: string };

// How much of the raw code the row shows. Two unknown codes queued in the same
// meal slot must not render as two identical rows — the user cannot tell which
// is which, and cannot tell a duplicate from a second product. The last four
// digits distinguish them without pretending a 13-digit EAN is a meal name;
// they are also the part that actually varies between two products from the
// same manufacturer, whose codes share a GS1 prefix.
const CODE_TAIL = 4;

function barcodeName(code: string | null): string {
  // `code` is typed nullable because QueuedCaptureRow is one shape for every
  // kind, not because a barcode row can lack one — captureQueue's isValid
  // rejects an empty code. The fallback is a type narrowing, not a state the
  // user can reach.
  if (!code) return "Scanned item";
  // Spelled out rather than punctuated ("Scanned item · 4321") because this
  // string is read aloud verbatim by the diary row's accessibility label.
  return `Scanned item ending ${code.slice(-CODE_TAIL)}`;
}

export function captureRowPresentation(
  row: Pick<QueuedCaptureRow, "kind" | "phrase" | "code">,
): CaptureRowPresentation {
  switch (row.kind) {
    case "text":
      // A text capture's own words are a better row title than "Typed note" —
      // the phrase IS the thing the user logged, and a queued row is otherwise
      // unidentifiable until it resolves.
      return { name: row.phrase ?? "Typed note", iconName: "message-circle" };
    case "photo":
      return { name: "Photo", iconName: "camera" };
    case "voice":
      return { name: "Voice note", iconName: "mic" };
    case "barcode":
      // "barcode" (SF `barcode`, lucide `Barcode`) already exists in the Icon
      // set — see src/components/Icon.tsx — so this needs no new asset. Not
      // "scan-barcode": that is the viewfinder glyph for the ACT of scanning,
      // which the capture screen's mode switcher uses; this row is the thing
      // that was scanned.
      return { name: barcodeName(row.code), iconName: "barcode" };
    default: {
      const unhandled: never = row.kind;
      throw new Error(`unhandled capture kind: ${String(unhandled)}`);
    }
  }
}
