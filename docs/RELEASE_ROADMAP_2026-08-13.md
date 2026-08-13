# Kora Release Roadmap — 2026-08-13

A re-plan of the open backlog against the R0→R3 strategy (personal →
friends-and-family → public). Supersedes the ordering in issue #40, which
predates everything shipped since.

**51 open issues.** 7 in R1, 12 in R2, 4 in R3, and **28 unmilestoned** — the
last number is the problem this document exists to fix. Most of the
unmilestoned set are correctness bugs from recent code reviews, and several
outrank the features sitting in milestones above them.

---

## 1. Where things actually stand

**Shipped since #40 was written:** onboarding & cold-start (#42), post-log
correction (#20), confidence tiers (#21), ED/medical guardrails (#23), the
HealthKit entitlement fix (#107), AI usage metering (#81), and — as of today —
**recipes (#25)**.

**In flight right now:** recipe metadata (tags + cooking steps), on
`feat/kora-recipe-tags`, one task of eight complete.

**Specced and parked, ready to resume:**

| Work | Spec | Why parked |
|---|---|---|
| Meal planner (#31) | `docs/superpowers/specs/2026-08-13-kora-meal-planner-design.md` | Sequenced behind metadata and preferences |
| Social recipes (#146) | `docs/superpowers/specs/2026-08-13-kora-social-recipes-design.md` | Large; deliberately deferred |

---

## 2. The single most important finding

**R1's own gate, #109 (TestFlight to F&F), lists #104 (crash reporting) as a
dependency — but #104 is filed in R2.** The milestone boundaries do not match
the dependency graph, which means R1 cannot be completed as currently
scoped.

The same is true of correctness: several unmilestoned bugs are more damaging
than anything in R2, and two of them undermine the app's core claim to be
accurate about food and energy.

---

## 3. Correctness bugs that outrank features

These are unmilestoned today. In a nutrition app they are not "chores".

| # | Issue | Why it outranks features |
|---|---|---|
| **142** | `useActivityHistory` double-counts Watch steps, **inflating the calorie target** | The app tells the user to eat more than it should. This is the product's central number being wrong, silently. |
| **138** | `portion_assumed` stops at confirm — the diary shows a guessed portion as fact | The app presents an estimate as a measurement. Partially addressed inside recipes; **the capture path is still wrong.** |
| **118** | migrate Job and API Deployment are not reliably ordered — a lost race takes down every authenticated request | A deploy can take the whole API down for all users. Availability, not polish. |
| **136** | Capture Cancel doesn't abort — burns AI budget and leaves the scanner dead for 25s | Wastes money on every cancel and looks broken. Now that per-user AI caps exist, it also eats a real user's budget. |
| **140** | BLOCKING: widget Steps unverified on device — Health-denied must render, not 0 | Renders a confident `0` where the truth is "not permitted". Same class of dishonesty as #138. |

**Recommendation: #142, #138 and #118 move into R1.** The other two into R1 if
cheap, R2 otherwise.

---

## 4. R1 — Friends & family beta

**Goal: a friend installs from TestFlight, onboards, and logs a meal against
production.** Nothing else belongs here.

### Critical path to #109

```
#106 account deletion ─┐
#108 social login ─────┼─→ #109 EAS build + TestFlight ─→ F&F install
#104 crash reporting ──┘        (Apple review queue: start early)
```

`#107` (HealthKit entitlement) is already closed. Apple-side setup has queue
time outside our control, so the App Store Connect record, privacy policy and
data-collection disclosure should be started **before** the code is finished.

### R1 contents after re-plan

| # | Issue | Status | Change |
|---|---|---|---|
| 106 | in-app account deletion | R1 | — (App Review blocker) |
| 108 | social login (Apple + Google) | R1 | — |
| 109 | EAS build + TestFlight | R1 | — (the gate) |
| 83 | 13 mutation call sites have no error surface | R1 | — |
| 22 | offline logging queue | R1 | — |
| 111 | offline-capture-queue follow-ups | R1 | — |
| 114 | social-login follow-ups | R1 | — |
| **104** | crash & error reporting | R2 | **→ R1** — #109 depends on it |
| **142** | Watch steps double-counted | none | **→ R1** — core number is wrong |
| **138** | guessed portion shown as fact | none | **→ R1** — capture path still wrong |
| **118** | migrate/deploy race downs the API | none | **→ R1** — availability |

**Beta without crash reporting is a beta you learn nothing from**, which is why
#104 must precede #109 rather than follow it.

---

## 5. R2 — F&F iteration

Once friends are using it, the question becomes retention and trust. Ordered by
dependency, not by wish.

**Tier 1 — make the beta observable and affordable**

| # | Issue | Note |
|---|---|---|
| 105 | Redis unreachable in prod, resolve cache disabled | Every resolve hits Gemini. Direct, ongoing cost. |
| 43 | success metrics & product instrumentation | Without it, R2 priorities are guesswork. |
| 97 | finish embedding the food index | Resolution runs on alias + full-text only until this lands; `cmd/embed` also exits 0 when it gives up, hiding the failure. |

**Tier 2 — the recipes programme** (see §7)

**Tier 3 — retention features**, in the order their dependencies allow:
#30 health integrations → #39 dynamic targets (needs #30's data);
#51 thin in-Kora AI coach → #27 smart weekly insights (both need #43's
instrumentation to tune); then #28 supplements, #29 fasting, #45 weight depth,
#46 gamification, #26 restaurant mode.

**Deferred out of R2:** #38 (grounded Q&A — overlaps #51; do #51 first and
re-evaluate).

---

## 6. R3 — Public launch prep

| # | Issue | Note |
|---|---|---|
| 24 | privacy — full data export + account deletion | #106 shipped the deletion subset in R1; this is the remainder |
| 44 | AI cost & latency budget | Partially built during recipes: per-user/global caps, metering and call-type budgets now exist. **Scope should be re-cut, not built from scratch.** |
| 41 | monetization — freemium, paywall, billing | Needs #43's numbers to price |
| 37 | AU-first localization | |

**Public launch also needs, and does not yet have an issue for:** a content
moderation path (only if #146 ships), an incident runbook, and a support
inbox. Flagged here rather than silently assumed.

---

## 7. The recipes programme

Recipes turned into a five-part programme. Current state:

| Part | Issue | State |
|---|---|---|
| Recipes — paste/photo → per-serving macros, loggable | #25 | **shipped** (URL import deferred) |
| Recipe metadata — tags + cooking steps | *none yet* | **in flight**, spec + plan written |
| Preferences & allergies | #36 (partial) | designed, not yet specced |
| Shopping list from selected recipes | #31 (part) | designed in principle |
| Meal planner | #31 | spec written, parked |
| Social recipes — publish/discover/fork/follow | #146 | spec written, parked |

**Sequencing decision:** metadata → preferences & allergies → shopping list →
meal planner → social. Each earlier item makes the next cheaper. In
particular the meal planner's candidate pool is weak without tags, dietary
constraints, and (eventually) shared recipes — which is why it moved back
rather than forward.

**Allergens carry a hard constraint that must not be lost:** `food_items` has
no allergen data, so conflicts can only be detected by matching ingredient
names against a curated mapping. That will miss real cases. The agreed
behaviour is **exclude conflicts from surfacing and warn prominently, never
certify a recipe as safe.** A wrong macro is an inconvenience; a missed
allergen is a hospital visit.

---

## 8. Housekeeping — proposed GitHub changes

**Not yet applied.** Each needs a decision.

**Milestone moves**
- #104 → R1 (dependency of #109)
- #142, #138, #118 → R1 (correctness/availability, see §3)
- #136, #140 → R1 if cheap, else R2
- #31 → R2 (currently unmilestoned despite being specced)
- #146 → R3 or later (currently unmilestoned)

**Close or re-scope**
- **#25** — paste and photo shipped; URL import was deliberately deferred.
  Either close with a scope note and open a small "recipe URL import" issue, or
  keep open re-titled to just the URL slice. Recommend the former.
- **#44** — re-cut. Per-user and global AI caps, metering, call-type budgets
  and the mobile-deadline fit all landed during recipes. The remaining work is
  model routing and cache strategy, which is a much smaller issue.
- **#40** — the execution order is stale. Point it at this document.

**New issues to open**
1. **Recipe metadata (tags + steps)** — in flight with no issue tracking it.
2. **Recipe URL import** — the deferred third input from #25.
3. **Shopping list from selected recipes** — currently only implied by #31.
4. **Mobile eslint is broken repo-wide** — eslint 10.8.1 no longer provides
   `eslint/config`, which `apps/mobile/eslint.config.js` requires, so
   `npx eslint` fails on every file. No mobile code has been linted for as long
   as that has been true.
5. **Nutrition tests fight the dev food index** — `go test ./...` truncates
   `food_items`, silently breaking live AI resolve afterwards; a seeded index in
   turn breaks the `internal/nutrition` embedding tests and one `internal/ai`
   test. The tests should own their fixture.
6. **`ai` package cannot meter an abandoned fallback leg** — the usage sink is
   unexported, so neither `recipes` nor `coach` can record a discarded primary
   call. Cost data is incomplete by construction.

---

## 9. Suggested next three pieces of work

1. **Finish recipe metadata** (7 tasks remain; branch is green at task 1).
2. **#142 and #138** — the two correctness bugs. Small, and they fix the app
   lying about its two most important numbers.
3. **#104 crash reporting**, to unblock the R1 critical path while the
   Apple-side paperwork for #109 runs in parallel.
