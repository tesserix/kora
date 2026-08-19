---
quick_id: 260819-sha
slug: screenheader-actions
date: 2026-08-19
refs: kora#264
---

# ScreenHeader's actions starve the title column

Fixes #264. Same class as the three readouts fixed in #263, but in the shared
header component.

## The failure

`src/components/ScreenHeader.tsx:31-77`. The outer row is
`flexDirection: "row"` + `justifyContent: "space-between"`, holding a `flex: 1`
title column and a bare `{right}` sibling with no flex constraint at all.

`flex: 1` means `flexShrink: 1` and `flexBasis: 0`, so the title column will
compress below its own content while `right` keeps its full intrinsic width. At
`accessibility-extra-large` on `app/recipes.tsx` the three action labels
("Paste", "Photo", "New") claim the row, the title column is starved to roughly
one glyph, and "Your recipes" / "Recipes" render **one letter per line** over
several screens with the list pushed off the bottom entirely.

Clean at `medium`. Screenshot: `scratchpad/scs/31-recipes-axl.png`.

## Blast radius is ONE screen, not twenty

Verify this yourself before deciding scope, but: 20 files render
`<ScreenHeader>` and **only `app/recipes.tsx:70` passes `right=`**. #264's
description overstates this — correct it in a comment when you are done.

That makes the fix low-risk, but it should still go in `ScreenHeader` rather
than in `recipes.tsx`: the omission is structural, and the next call site to
pass actions would inherit it silently.

## Direction, not prescription

Carry the two lessons from #263 — they cost a cycle each there:

1. **`flexShrink` is not automatically right.** It narrows a box past the word
   it holds; applied to a short unit it split "kg" into "k" / "g". For a row of
   short indivisible labels, letting the ROW wrap so items drop whole is
   usually correct.
2. **Find what constrains the measurement.** In the tab bar the culprit was a
   `width` pinning the label's measured box, not the font cap that looked
   responsible. Establish what is actually starving the title column here
   before choosing a fix.

Likely shape: stop `right` from compressing the title (it needs to not take
more than its share), and/or let the header row wrap so the actions drop to
their own line at large text sizes. Measure, then choose.

Also worth asking, and worth saying plainly in your report if you think so:
three text actions in a header may simply be the wrong pattern at accessibility
sizes, and an overflow menu may be the honest answer. That would be a design
change — do NOT make it here, but say so if the evidence points that way.

## Second, smaller finding in the same issue

`ScreenHeader`'s overline collides with the floating settings gear. At
accessibility sizes it overlaps "Grounded in your logs", and on the recipes
screen it covers part of "New" **even at `medium`** — so this half is not
accessibility-specific. Fix it if it is genuinely small; if it turns out to be a
layering/positioning question about the gear rather than the header, report that
and leave it.

## Getting to the screen — READ THIS, it saves a cycle

The recipes screen is behind auth AND behind completed onboarding.

The previous session could not complete onboarding because `EXPO_PUBLIC_API_URL`
points at `http://localhost:8080`, where port 8080 is a `kubectl port-forward`
to an embeddings service — so profile writes 404. That agent worked around it by
short-circuiting the tabs gate, which works but leaves you unable to trust
anything data-driven.

**Prefer pointing at prod instead.** Env vars beat `.env`, so start a SECOND
Metro rather than editing the user's `.env`:

    cd apps/mobile
    EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo start --dev-client --port 8083
    xcrun simctl openurl <udid> "com.tesserix.kora://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8083"

Do NOT kill the Metro already running on 8082 — it is not yours. Use 8083.

If prod also refuses, fall back to the gate short-circuit, but say clearly in
your report which path you used, and make sure no probe reaches a commit.

## Constraints

- **A green suite is NOT verification.** Screenshots at BOTH `medium` and
  `accessibility-extra-large`. This whole line of work exists because 1,729
  green tests hid a rendering bug (#257).
- `medium` must be visually unchanged.
- Check the other `ScreenHeader` consumers at accessibility sizes too — a
  change to a shared component needs more than its one failing caller as
  evidence. Notifications and Settings are easy ones to spot-check.
- Do not touch #261 (ruler `SvgText`) or the two LOW items still on #173.

## Acceptance

- Recipes header renders title and actions legibly at both sizes, list reachable.
- At least two other `ScreenHeader` screens spot-checked at both sizes.
- `medium` unchanged.
- A comment-worthy note correcting #264's blast-radius claim.
- Atomic commits, single-line conventional messages, NO signature, NO
  Co-Authored-By trailer.
