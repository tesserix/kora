# Onboarding defaults and the Plan page

Date: 2026-10-29
Status: draft, for approval

## Why

A tester onboarded and got targets she never chose. She set sex, age, height and
weight. Activity (`moderate`), goal (`fat_loss`), goal weight (current − 5 kg) and
pace (0.5 kg/week) were all saved from untouched defaults. Kora gave her 146 g
protein. Her dietitian gives 120–130 g. After onboarding she had no way to change
any of it, because targets are read-only in Profile.

Three things went wrong:

1. **Untouched defaults count as answers.** The onboarding screen starts with
   every control on a value (`apps/mobile/app/onboarding.tsx:114-126`): Male,
   Moderate, 30, 170 cm, 70 kg, Fat loss, 2nd pace. Submitting without touching
   them saves them.
2. **Protein is a flat 2.0 g/kg of current weight** (`api/internal/onboarding/calc.go`,
   `proteinGPerKg`). That is the top of the range for someone strength training
   in a deficit. It ignores goal and activity.
3. **Targets can't be changed after onboarding.** There's no endpoint and no
   screen for it. A user with numbers from a professional has nowhere to put them.

## Goals

- Nothing that changes a target is saved unless the user chose it.
- Protein follows goal and activity, not a single constant.
- One Plan page shows the targets with their working. Each number can be
  overridden, and Otto can propose changes in plain language.
- The same Plan page is the last step of onboarding and is reachable from
  Profile any time after.
- When the user's weight moves, Kora recalculates and Otto offers the update.
  The user's numbers never change without their approval.

## Non-goals

- Redesigning the onboarding screen's layout or steps. It stays as it is.
- Otto choosing numbers. Otto proposes; the formula and guardrails produce every
  value that gets saved.
- Changing how activity is inferred from Apple Health / Health Connect.
- Meal plans. `coach/plan_proposal.go` stays as it is.

## Anti-goals (would be a failure even if it worked)

- A target below resting burn (BMR) reaching the user by any path: formula,
  override, or Otto. The existing floor in `calc.go` applies to all of them.
- Otto proposing a lower calorie target to a user `guardrails.AtRisk` flags.
- Onboarding or the Plan page failing because Otto is slow or down.
- A user's override silently replaced.

## Constraints

- **Server is authoritative; client mirrors it.** `apps/mobile/src/lib/plan.ts`
  mirrors `calc.go` for live readouts. `api/internal/onboarding/testdata/golden_targets.json`
  is asserted by both test suites. Any formula change updates all three together.
- **Design rules:** `sketch-findings-kora` (Ignition). One bezel cluster per
  screen, one orange accent per screen, Menlo tabular numerals, trust
  disclosures in readable sentence case.
- **Kora is app-only.** Native screens only (see memory: no hosted web pages).
- **Existing propose → accept pattern:** `mentor` already stores agent-drafted
  proposals and accepts them through `PUT /v1/mentor/proposals/:id/accept`.
  The stored weight-change suggestion (section 5) follows that shape. Otto's
  chat proposals on the Plan page are not stored. They only edit the draft on
  screen, and the draft is saved through `PUT /v1/me/plan`.
- **Current weight** means the latest entry in `weight_entries`. `users.weight_kg`
  is only written at onboarding and goes stale. Saving the plan writes the
  weight it used back to `users.weight_kg` and `plan_basis_weight_kg`. It does
  not log a weigh-in; editing weight on the Plan page logs one through the
  existing tracking path.

## Decided (by the user)

1. **Onboarding keeps its current screen and layout, with every value starting
   unset.** That includes sex. Unset fields look clearly unanswered. The submit
   button stays disabled until all of them are set.
2. **A Plan summary page comes after onboarding.** It shows calories with their
   working and protein, carbs and fat with their basis. Otto chat sits below.
   The user can adjust the plan by talking to Otto.
3. **The Plan page is reachable from Profile** through a "Your plan" row, so
   targets can be changed any time.
4. **When weight changes, Kora recalculates and Otto suggests the update.**
   Otto sends a notification saying the numbers changed, here's the suggestion.
   An override stays in force until the user accepts Otto's suggestion.
5. Mockup approved: `.superpowers/brainstorm/18360-1793239756/content/onboarding-flow.html`.

## Design

### 1. Onboarding: no defaults

- Every input that feeds the calculation starts with no value: sex, age, height,
  weight, activity, goal, goal weight, pace.
- Rulers show "Slide to set" until first touched. Segmented choices show no
  selection, using a dashed well (see mockup).
- Goal weight and pace are only shown once goal and weight are set. Their
  suggested values (current ± 5 kg; the 2nd pace stop) appear as a
  starting position labelled as a suggestion. They count as unset until the
  user touches them or taps "Use suggestion".
- Activity keeps the Apple Health / Health Connect suggestion
  (`ActivityFromHealth`). Accepting it counts as choosing.
- A counter ("2 more to answer") replaces the live plan readout until
  everything is set. The calorie readout is meaningless with half the inputs.
- "See my plan" stays disabled until all fields are set. It opens the Plan
  page and does **not** submit. Onboarding is saved from the Plan page.
- Server: `POST /v1/onboarding` keeps its validation. No defaults are added
  server-side.

### 2. Protein formula

Protein = factor × reference weight.

Reference weight: goal weight for `fat_loss` when one is set, current weight
otherwise.

| Goal | Sedentary | Light | Moderate | Active | Very active |
|---|---|---|---|---|---|
| fat_loss | 1.6 | 1.6 | 1.8 | 1.8 | 1.8 |
| maintenance | 1.2 | 1.4 | 1.6 | 1.6 | 1.6 |
| muscle_gain | 1.8 | 1.8 | 2.0 | 2.0 | 2.0 |

Fat stays at 25% of calories; carbs take what's left, clamped at 0 (unchanged).

For the tester: fat loss, 68 kg goal → 109 g (light) or 122 g (moderate). Her
dietitian's 120–130 g is reachable with one override.

*My call:* the factors. They sit inside the 1.2–2.2 g/kg range current
guidance gives, and they are higher in a deficit to protect muscle. They are a
starting point, and overrides exist for anyone with professional advice.

### 3. Plan page (new screen)

One bezel cluster (Ignition):

- **Calories**: hero numeral with the working underneath, built with the
  existing `DerivationChain` component: burn − deficit = target. If the floor
  applied, say so in plain words.
- **Macros**: protein, carbs, fat. Each shows its basis: "1.6 g/kg goal wt",
  "the rest", "25%". A value the user overrode shows "Your number" instead.
- **Editing**: tapping a number opens a numeric input.
  - Calories and protein can be overridden; carbs are then recomputed as the rest.
  - Fat can't be overridden. *My call:* it keeps the editor to two numbers and
    the split stays consistent.
  - Override bounds:
    - Calories: ≥ BMR, ≤ 2 × TDEE.
    - Protein: 0.8–2.5 g/kg of current weight, and its calories ≤ 75% of the
      calorie target. That leaves room for fat's fixed 25%. (*my call*)
  - When the inputs change while an override is set (weight, activity, goal),
    the override stays and is checked again against the new bounds. If it no
    longer fits, the number is marked and Save stays disabled until the user
    adjusts or clears it. It is never changed for them. (*my call*)
  - Out-of-range values are refused with a one-line reason.
- **Inputs**: a link row "Body, activity & goal" opens the same controls as
  onboarding, pre-filled. Changing them recalculates.
- **Otto**: chat below the cluster (see section 4).
- **Primary action**:
  - During onboarding: "Start with this plan", which submits onboarding and the
    targets together.
  - From Profile: "Save".
  - Nothing is saved until this is tapped.

Profile gains a "Your plan" row (`apps/mobile/app/profile.tsx`). It shows
calories and a CUSTOM tag when any override is active.

### 4. Otto on the Plan page

- The user types free text: "my dietitian said 120–130 g protein", "I barely
  work out", "slower pace".
- The server sends it to Otto with the current inputs and targets. Otto returns
  a structured change limited to:
  - activity level
  - goal
  - goal weight
  - pace
  - calorie override (or clearing it)
  - protein override (or clearing it)
- The server applies the change through the formula and the bounds above, then
  returns a **proposal card**: each changed field "old → new", plus the knock-on
  effect, such as "Carbs 184 → 168 g".
- The user taps "Use this" or "Not now". "Use this" updates the page. It does
  not save; the primary action still does that.
- Otto may also reply with only text (an explanation, no change). That's
  allowed.
- **Guardrails**: if `guardrails.AtRisk` is true for the user, any proposal
  that lowers calories or speeds up the pace is dropped. Otto's reply uses the
  existing at-risk support path instead. During onboarding there's no logging
  history, so this has no effect then.
- **AI allowance (decided by the user):** each message counts as AI usage
  through the existing meter (`billing.Meter.WithinBudget`), the same as coach
  chat. Every user has the free allowance from sign-up (20 requests a day,
  100 a week, 300 a month, $5 a month), so onboarding needs no purchase.
  When the allowance is used up, the chat says so in one line and points to
  editing the numbers directly. The rest of the page works.
- The weight-change suggestion is computed by the formula, not Otto, so it
  uses no allowance. Only its wording is fixed copy in Otto's voice.
- **Failure**: if Otto errors or times out, the chat shows a one-line
  "Otto couldn't answer, you can still edit the numbers directly" and the rest
  of the page works.

### 5. Weight changes: recalculate, Otto suggests

- Store the weight the plan was calculated from (`plan_basis_weight_kg`).
- Weight is compared as the 7-day average of weigh-ins, not a single reading
  (*my call*). Daily swings of 1–2 kg are water, and Health-synced scales log
  every one. Checked whenever a weigh-in is recorded, manual or synced.
- When that average differs from the basis by ≥ 2 kg (*my call*), Kora recalculates
  in the background. If any target would change by ≥ 5% (*my call*), Kora
  raises a plan-update suggestion.
- **Otto notifies the user (decided by the user).** The suggestion goes out
  through the existing channels:
  - a push notification (`api/internal/push`, Expo)
  - an entry in the in-app notification feed (`api/internal/notifications`)
  - a nudge card on Home
  All three are written in Otto's voice, for example: "Your weight has moved
  2 kg since we set your plan. I've re-run the numbers: 1,560 kcal, 115 g
  protein. Take a look?" Tapping any of them opens the Plan page with the
  proposal card showing old → new.
- **Only for a meaningful change (decided by the user: not every minor change).**
  A suggestion, and so a notification, needs all of these (thresholds are *my
  call*):
  - the 7-day average weight is ≥ 2 kg from the plan's basis weight
  - that gap has held for 7 days, so a single heavy or light week doesn't
    trigger it
  - at least one target would change by ≥ 5%; for the tester that's about
    80 kcal or 6 g protein
  - it's been ≥ 21 days since the last plan-update notification, whether
    accepted or not
- If any of these fails, nothing is sent. The plan stays as it is and Kora
  checks again at the next weigh-in.
- At most one plan-update push per suggestion. The push respects the user's
  existing notification permission; with push off, the feed entry and the Home
  card still appear.
- Overrides: the suggestion shows Kora's recalculated value next to the user's
  number. The user's number stays until they accept the suggestion.
- One open suggestion at a time. Declining it ("Not now") moves the comparison
  point to the current weight. The next suggestion needs a further 2 kg move
  from there, and the 21-day gap applies too.
- Accepting a suggestion replaces every target with Kora's recalculated
  values and clears both overrides. The card shows the overridden values
  being replaced, so this is never silent. (*my call*)
- **Storage (*my call*):** a new `plan_suggestions` table, one row per
  suggestion. It holds:
  - user
  - status: open / accepted / dismissed
  - the proposed inputs and targets, as computed when the suggestion was made
  - the comparison weight
  - `gap_first_seen_at`, which is how the 7-day hold is tracked
  - `notified_at`
  The 21-day gap is read from the latest `notified_at`.
- **When it runs (*my call*):** inline, after every weigh-in write: the
  tracking add-weight handler and the Health sync batch. One check per batch.
  The check is cheap (one average and one formula call), so no background job.
- **Risk gating (*my call*):**
  - The new code calls `guardrails.AtRisk` directly. An at-risk user gets no
    suggestion that lowers calories or speeds up the pace. Suggestions that
    raise calories still go out.
  - It does **not** go through `BuildNudges` / `Evaluate`. Those are
    additive-only by tested design, and `Evaluate` would soften a restrictive
    nudge for every other user.
  - The Home card is its own component, fed by the open suggestion, not a nudge.
  - The same direct check gates Otto's chat proposals in section 4.

### Data

Add to `users`:

| Column | Purpose |
|---|---|
| `target_kcal_override` (nullable) | User's own calorie number |
| `target_protein_override_g` (nullable) | User's own protein number |
| `plan_basis_weight_kg` | Weight the plan was calculated from |

The effective targets (`target_kcal`, `target_protein_g`, `target_carbs_g`,
`target_fat_g`) stay where every reader already uses them. They are written as
the formula result with overrides applied, so no reader changes.

### API

- `POST /v1/onboarding`: also accepts the two optional overrides. Validates
  them against the bounds and saves everything in one transaction.
- `PUT /v1/me/plan` (new): inputs + overrides → recomputed, validated, saved.
  Returns the plan with each value's basis.
- `POST /v1/me/plan/preview` (new, no save): same body. Returns the computed
  plan, so the client can show bounds errors from the server.
- `POST /v1/me/plan/otto` (new): free text + current draft → reply text and an
  optional proposal (changed fields + resulting plan). Stateless and not stored.
  *My call:* no chat history on this page. Each message stands alone with the
  current draft as context, which keeps it simple and cheap.
- `GET /v1/me/plan/suggestion` (new): the open suggestion, or 204. Used by
  Home and by the Plan page.
- `POST /v1/me/plan/suggestion/:id/accept` (new): applies the stored targets,
  clears overrides, and marks it accepted. It recomputes and checks bounds
  first, refusing if the result has drifted.
- `POST /v1/me/plan/suggestion/:id/dismiss` (new): "Not now". Marks it
  dismissed and moves the comparison weight to the current weight.

### Notifications from Otto

The feed and push are built for one user acting on another. `actor_id` is
`NOT NULL`, there is no text column, and the push copy is "actor + verb".
*My call:*

- **Migration:**
  - `notifications.actor_id` becomes nullable; NULL means Otto.
  - Add `type = 'plan_update'`.
  - Add a `payload JSONB` holding the suggestion id and the numbers as they
    were when it was sent. Sent text never changes after the fact.
- **Feed query and push outbox query:** `LEFT JOIN` the actor.
- **Push copy and the mobile `notifications.tsx` renderer:** render
  `plan_update` from the payload with Otto as the sender.
- **Tap:** opens the Plan page.

### Existing users

- Already-onboarded users keep their targets.
- *My call:* one-time Home card, "Check your plan: we've improved how protein is
  worked out", that opens the Plan page.
- Their protein isn't recalculated until they save.
- **Backfill:** `plan_basis_weight_kg` comes from `users.weight_kg` (the
  weight their current targets were built from).
- No weight-change suggestions go to them until they've saved the plan once.
  Otherwise the move from 2.0 g/kg to the new factors would trigger a
  "your weight moved" notification that's really a formula change. (*my call*)
- **Routing:** the Plan page must be reachable before `onboarded_at` is set,
  because it is the last onboarding step. The existing onboarding route gate
  needs to allow it.

## Left to the builder

- Exact unset visuals within the Ignition rules.
- How the Plan page's Otto call reuses the agents gateway and prompt setup in
  `api/internal/agents` / `coach`.
- Copy, apart from the safety and failure lines above.
- Test layout. It must include golden-file updates for the new protein table in
  both Go and TS.
