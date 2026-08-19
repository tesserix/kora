---
quick_id: 260819-sha
slug: screenheader-actions
date: 2026-08-19
refs: kora#264
status: done
---

# ScreenHeader's actions starve the title column — fixed

One file changed: `apps/mobile/src/components/ScreenHeader.tsx`.

## What was actually wrong

Measured on iPhone 17 Pro Max at `accessibility-extra-large`, `app/recipes.tsx`,
400pt inner header row (440pt screen − 40pt horizontal padding):

| | title column | actions (`right`) | header height |
|---|---|---|---|
| before | **70pt** | 318pt | **1183pt** |
| after | 400pt | 318pt, own line | **244pt** |

`right` sat at its full intrinsic width because a bare `{right}` sibling keeps
RN's default `flexShrink: 0`. The title column had `flex: 1` — `flexBasis: 0` +
`flexShrink: 1` — so it absorbed the entire deficit with no floor, down to 70pt
including the 40pt back button. That left ~30pt for a 90pt glyph, so
"Your recipes" / "Recipes" rendered one letter per line down several screens
and pushed the list off the bottom.

No font cap and no `width` was involved. The numbers above are from `onLayout`
probes, not from reading the styles.

## The fix

Row wraps; the title column stops collapsing before the wrap decision is made.

```
outer row      + flexWrap: "wrap", rowGap: 10, columnGap: 12
title column   flex: 1        -> flexGrow: 1, flexShrink: 0
inner text col flex: 1        -> flexShrink: 1
```

Short indivisible labels drop **whole** onto their own line rather than being
squeezed — `flexShrink` on `right` was rejected for the reason kora#263
recorded ("kg" split into "k" / "g"; "Paste" would go the same way).

### Two wrong turns, both recorded in the file

1. **`flexWrap` alone did nothing.** With `flexShrink: 1` still on the title
   column, yoga collapses it while choosing the line break: 70 + 12 + 318 fits
   in 400, so the line never broke. A `columnGap: 200` probe proved `flexWrap`
   was live; toggling grow/shrink showed the column's true hypothetical size is
   400pt. `flexShrink: 0` is what makes the wrap fire.
2. **Fixing the outer column alone regressed `medium`.** With the inner column
   still `flex: 1` it *grew* during the parent's basis measurement, so the title
   column reported the whole 400pt row regardless of the title, and the actions
   wrapped at `medium` too. Dropping the inner `flexGrow` fixed it.

## Verification — screenshots, not the suite

Byte-comparison of full-screen captures, same build, same session, fix applied
vs `git checkout`-ed back to HEAD.

**`medium` — 4 screens, all BYTE-IDENTICAL to HEAD:**
recipes, settings, notifications, coach.

**`accessibility-extra-large` — 11 screens, 10 BYTE-IDENTICAL to HEAD:**
settings, notifications, coach, delete-account, about, ai-usage, feedback,
friends, groups, profile. Only **recipes** differs, which is the fix.

Also verified at AXL: title, overline and all three actions legible; the list
body (empty state) is reachable on the first screen; the relocated "Paste"
action is still tappable and opens `RecipeParseSheet` in paste mode.

`npx tsc --noEmit` clean. `editorial-primitives.test.tsx` 6/6 pass. The suite
was never the evidence here — kora#257 is why.

## Blast radius — kora#264 overstated it

20 files render `<ScreenHeader>`; **exactly one passes `right=`**
(`app/recipes.tsx:70`). The other `right={...}` hits in `app/` belong to
`Row` / `GroupedList`, not to `ScreenHeader`. Fixed in the component anyway:
the omission is structural and the next caller to pass actions would inherit it
silently. Noted in a comment on the `right` prop.

## Second finding in the issue — NOT a bug

The "floating settings gear" that overlaps the overline is `expo-dev-menu`'s
draggable FAB (`node_modules/expo-dev-menu/ios/FAB/DevMenuFABView.swift:94`,
`Image(systemName: "gearshape.fill")`), persisted at a user-dragged position in
`UserDefaults`. No app code renders a gear anywhere except a `more.tsx` list
row. It is dev-client chrome and does not exist in a release build. Nothing
changed for it.

## Not addressed — a design question, deliberately left open

Three text actions in a header is a fragile pattern at accessibility sizes.
At AXL the actions measure 318pt of a 400pt row on their own; "Paste Photo New"
only just fits on one wrapped line, and a fourth action, a longer verb, or a
non-English locale would overflow again. The wrap makes the current header
correct and legible, not comfortable. An overflow menu is likely the honest
answer. That is a design change and was out of scope here.

## How the screen was reached

Prod Metro on port 8083 (`EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app`,
passed as an env var — the user's `.env` was not edited, and the Metro on 8082
was left alone), a real throwaway account created through the app's own signup,
then `xcrun simctl openurl … "com.tesserix.kora://recipes"`. `/recipes` sits
outside the `(tabs)` group, so the onboarding gate is not on that path and **no
gate short-circuit or probe was needed**. The throwaway account was deleted via
the app's delete-account flow. Simulator content size restored to `medium`.

Prod was returning `503 no healthy upstream` at the start of the session and
recovered partway through; it did not affect the header measurements, which are
static text.

## Files

- `apps/mobile/src/components/ScreenHeader.tsx`
