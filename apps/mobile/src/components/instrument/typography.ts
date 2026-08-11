import type { TextStyle } from "react-native";
import type { InstrumentTokens } from "@/theme";

type Fonts = { mono: string };

// The single canonical mono-numeral recipe (spec: Type > "Data face" — the
// platform monospaced face with tabular figures for every numeral that can
// change). Route every mono numeral in instrument-glass components through
// this instead of re-typing the two-line literal.
export function monoStyle(fonts: Fonts): Pick<TextStyle, "fontFamily" | "fontVariant"> {
  return { fontFamily: fonts.mono, fontVariant: ["tabular-nums"] };
}

// The single canonical engraved-label recipe (spec: Type > "Engraved labels"
// — 9–11px uppercase, mut color, tracked out, used only where an instrument
// would engrave a label). GaugeDial's two internal dial captions are the one
// documented exception (see GaugeDial.tsx) — everything else routes here.
export function engravedStyle(instrument: InstrumentTokens): TextStyle {
  return {
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: instrument.mut,
    fontWeight: "600",
  };
}
