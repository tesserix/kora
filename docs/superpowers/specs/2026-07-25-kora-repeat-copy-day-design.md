# Design — Repeat a meal + Copy a day

**Date:** 2026-07-25
**Branch:** `phase-2-nutrition-engine` (PR #5)
**Type:** Mobile-only feature (both backend endpoints already exist and are tested)

## Summary

Two related re-logging capabilities that reuse existing backend endpoints:

1. **Repeat a single meal** — one-tap "log this again" from the meal detail sheet. The copy
   lands **today** (now), matching the "I'm eating this again" mental model.
2. **Copy a whole day** — from an **empty** viewed day in the Diary, pull in all logs from a
   chosen recent day. Meal-prep use case.

No new backend work. This is hooks + UI on the mobile app.

## Backend (already built — reference only)

- `POST /v1/logs/:id/repeat` — body `{ at?: RFC3339 }`. Clones one log; `at` defaults to
  `time.Now()` when omitted/zero. Returns `201 { data: FoodLog }`.
  (`api/internal/foodlog/handler.go:148`, service `RepeatLog` at `service.go:187`.)
- `POST /v1/logs/copy-day` — body `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }`. Clones every log
  from `from`→`to`, preserving each entry's time-of-day (adds the whole-day delta). Returns
  `200 { data: { copied: n } }`. (`handler.go:120`, service `CopyDay` at `service.go:166`.)

Both are user-scoped and mounted in the authed v1 group (`router.go:66-67`).

## 1. Data layer — `apps/mobile/src/api/hooks.ts`

### New: `useRepeatLog()`
- Mutation: `apiFetch("/v1/logs/${id}/repeat", { method: "POST" })` — **no body**, so the backend
  defaults `at` to now → the copy lands today.
- Typed return: `Promise<FoodLog>`.
- `onSuccess`: `qc.invalidateQueries({ queryKey: ["logs"] })` +
  `qc.invalidateQueries({ queryKey: ["dashboard"] })` (prefix invalidation refreshes today's
  timeline and dashboard rings; dated keys are `["logs", date]` / `["dashboard", date]`).

### Existing: `useCopyDay()`
- Already present and already invalidates `["logs"]` + `["dashboard"]` on success.
- Change: type its mutation return as `Promise<{ copied: number }>` so callers can branch on the
  result. `apiFetch` unwraps the `{ data }` envelope, so the resolved value is `{ copied }`.

## 2. Repeat — meal detail sheet (`apps/mobile/app/meal.tsx`)

- Extend the existing bottom action row. Current: `[trash icon-square] [Save changes]`.
  New: `[trash icon-square] [repeat icon-square] [Save changes]`.
  - The repeat button mirrors the delete button's style: 48×48 bordered square, `Icon name="repeat"`,
    ink/foreground color (not destructive). Accessibility label "Repeat entry".
  - **Prerequisite:** `Icon.tsx` has no `repeat` glyph (unknown names silently fall back to `Circle`).
    Register `repeat: Repeat` from `lucide-react-native` in the `Icon` MAP as part of this change.
- On press → `repeatLog.mutate(p.id, { onSuccess, onError })`.
  - `onSuccess`: `router.back()`, then `Alert.alert("Logged again", "Added to today's diary.")`.
    A confirmation is used because the copy lands **today**, which may not be the day currently in
    view, so the result is otherwise invisible.
  - `onError`: set the existing inline `err` state to `"Couldn't repeat. Try again."`.
- Extend the `busy` guard: `busy = editLog.isPending || deleteLog.isPending || repeatLog.isPending`
  (any in-flight mutation disables all three actions).

## 3. Copy-a-day — empty-state CTA + `CopyDaySheet`

### Entry point (`apps/mobile/app/(tabs)/diary.tsx`)
- Only when `logged.length === 0`: below the existing "Nothing logged this day." line, render a
  **"Copy from another day"** pressable (moss/primary text link, restrained — no persistent button).
- Tapping opens `CopyDaySheet` with `targetDate = selected`. Never rendered when the day already has
  logs, so copying can never silently double-log a populated day.

### New component `apps/mobile/src/components/diary/CopyDaySheet.tsx`
- Props: `{ visible: boolean; targetDate: string; onClose: () => void }`.
- Renders the shared `Sheet` (controlled `visible`/`onClose`).
- Content:
  - Overline/title "Copy a day" + a short subtitle naming the target date.
  - **Source-day chips**: the last 7 calendar days ending today, excluding `targetDate` and any
    future day (a source can only be past-or-today). Each chip shows weekday + day-of-month, styled
    like the Diary week strip.
  - Chip press → `copyDay.mutate({ from: chipISO, to: targetDate }, { onSuccess, onError })`.
    - `copied > 0`: `onClose()`. The viewed day's timeline repopulates via invalidation — the fill-in
      is the feedback.
    - `copied === 0`: keep the sheet open, show inline "That day had nothing to copy."
    - error: inline "Couldn't copy. Try again."
  - While `copyDay.isPending`, chips are disabled (dimmed).
- Local ISO helper matches diary's `toLocaleDateString("en-CA")` convention for day strings.

## Error handling

- Every failure path is visible: inline text (meal-sheet repeat error; copy error/empty) or an Alert
  (repeat success). No silent catches.
- `copied === 0` is handled explicitly rather than treated as success.
- Copy into a non-empty day is structurally prevented (CTA hidden unless the day is empty).

## Testing

- `useRepeatLog`: POSTs to `/v1/logs/:id/repeat` with no body; invalidates `["logs"]` +
  `["dashboard"]` on success.
- Meal sheet repeat: success → `router.back()` + confirmation Alert; error → inline text; the repeat
  action participates in the `busy` gate.
- `CopyDaySheet`: chip list excludes the target day and future days; `copied > 0` → `onClose` called;
  `copied === 0` → inline empty message, sheet stays open; error → inline error text; chips disabled
  while pending.
- Diary: the "Copy from another day" CTA renders only when the viewed day has no logs.
- Suite stays green: `npx tsc --noEmit` + `npm test -- --ci` (currently 142/142). Jest mock factories
  reference only `mock`-prefixed vars.

## Out of scope (YAGNI)

- Repeat to an arbitrary day/time (only "today" now).
- Copy into a non-empty day / append semantics.
- Source-day meal-count badges or a full calendar picker (last-7-days chips only).
- A global toast/snackbar system (reuse `Alert` + inline text).
- Any backend change.

## File-level plan

| Change | File |
|---|---|
| `useRepeatLog` hook; type `useCopyDay` return | `apps/mobile/src/api/hooks.ts` |
| Register `repeat` glyph in the Icon MAP | `apps/mobile/src/components/Icon.tsx` |
| Repeat action + Alert + busy gate | `apps/mobile/app/meal.tsx` |
| Empty-state "Copy from another day" CTA + sheet mount | `apps/mobile/app/(tabs)/diary.tsx` |
| New source-day picker sheet | `apps/mobile/src/components/diary/CopyDaySheet.tsx` |
| Tests | co-located `__tests__` per existing convention |
