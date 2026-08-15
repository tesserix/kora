// Screen-entrance direction (spec: Task 9 "screen transitions") — tracks which
// tab was last focused so the next screen's entrance animation knows whether
// to slide in from the left or the right of the dock.
//
// A plain module-level variable, not React state or context: it needs to
// survive across screens/renders and be read+updated SYNCHRONOUSLY, in one
// step, from inside the newly-focused screen's own `useFocusEffect` (see
// ScreenEntrance.tsx) — before that screen paints anything. Routing it
// through a second hook + setState would introduce a one-frame race (the
// state update wouldn't be visible until the NEXT render, one focus-cycle
// too late), so this is deliberately the "module-level ref shared with the
// tab bar" wiring the design contract calls out as the simpler option, with
// "the tab bar" generalized to "whichever screen last held focus" rather
// than requiring `FloatingTabBar` itself to participate.
let lastFocusedIndex = 0;

export type ScreenDirection = 1 | -1;

// Resolves the direction the screen at `index` should enter from, then
// records it as the new last-focused index. Ties (re-focusing the same tab,
// which expo-router does not normally trigger, and the very first mount)
// resolve to +1 — an arbitrary but harmless default since there is no
// meaningful "previous" tab yet.
export function resolveScreenDirection(index: number): ScreenDirection {
  const direction: ScreenDirection = index >= lastFocusedIndex ? 1 : -1;
  lastFocusedIndex = index;
  return direction;
}
