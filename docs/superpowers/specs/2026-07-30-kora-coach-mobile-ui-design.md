# Design — Kora Coach mobile UI (+ backend enrichment)

**Date:** 2026-07-30
**Status:** approved (design)
**Mockup (authoritative):** `design-system/ui_kits/kora/CoachScreen.jsx`
**Backend shipped in:** #51 (PR #55) — `api/internal/coach/`
**Depends on:** PR #56 (CI fix) merged, so `build-image` runs and deploys stop needing a manual `docker buildx`.

## Problem

The coach backend is live (`GET /v1/coach/nudges`, `POST /v1/coach/ask`) but has no UI. The `CoachScreen.jsx` mockup cannot be built against the API as shipped:

| Mockup needs | API returns |
|---|---|
| focus card `title` | — |
| `icon` + `hue` + `variant` | — |
| rich body copy | `text`: terse (`"18g protein to go"`) |
| 3 cards incl. **Weight trend** | only 2 nudge kinds (protein gap, fibre streak) |
| multi-turn thread | `/ask` is stateless, no history |
| — | `citations: [{label,value}]` has no slot |
| — | `show_support` (ED-risk flag) has no slot |

`Nudge.Reason` is **not** a title — it is a policy-audit string (`"restrictive nudge suppressed: ED-risk signal present"`). Rendering it would leak guardrail internals.

## Decisions

1. **Enrich the backend** rather than adapt the UI or duplicate coach presentation logic client-side. Presentation-relevant classification stays server-side next to the guardrails that gate it.
2. **Server-side thread history**, but **store + replay only** — each `/ask` stays independently grounded on the deterministic Context block. Prompt construction is unchanged, so the existing guardrail tests keep their meaning.
3. **`show_support` → persistent card** above the focus cards, never blocking use of the coach.
4. **Citations → chips** under Otto's bubble, following the existing `ProvenanceChip` pattern.
5. **Entry:** `app/coach.tsx` pushed route (matching the mockup's back arrow) + a compact home entry card showing the top nudge.

Delivered as three independently reviewable, independently deployable PRs. If R1 timing slips, PRs 1+3 alone ship a working coach; thread persistence is the droppable piece.

---

## PR 1 — Nudge enrichment

### Struct

```go
type NudgeKind string

const (
    NudgeKindProtein     NudgeKind = "protein"
    NudgeKindFibre       NudgeKind = "fibre"
    NudgeKindWeightTrend NudgeKind = "weight_trend"
)

type Nudge struct {
    Kind   NudgeKind `json:"kind"`
    Title  string    `json:"title"`
    Text   string    `json:"text"`
    Reason string    `json:"reason"` // unchanged — audit only, never rendered
}
```

The client maps `Kind → icon + hue + variant`. The server ships no presentation details.

### Safety issue 1 — the weight-trend card is *gated*, not softened

Marking it `Restrictive: true` does not work: with no risk present `Evaluate` returns `Soften` and replaces `Text` with the fixed `"Nice work today — you're on track."`, destroying the trend for exactly the users who should see it. Leaving it `Restrictive: false` would show weight-loss framing to a user with active ED-risk signals.

**Resolution:** keep `Restrictive: false` and only add the candidate when `!guardrails.AtRisk(signals)`.

This widens the signature:

```go
func candidateNudges(c Context, s guardrails.Signals) []guardrails.Nudge
```

Gate the candidate; do not soften it.

### Safety issue 2 — `Title` must be sanitised on `Soften`

`Evaluate` sanitises `Text` but knows nothing about a title. The first restrictive candidate anyone adds would produce:

> **Fibre is low**
> Nice work today — you're on track.

Today every candidate is `Restrictive: false`, so `Soften` never fires — this would ship as a latent trap, not a visible bug.

**Resolution:** carry the safe title through `guardrails.Decision` so sanitisation lives inside the tested `guardrails` package rather than relying on each caller to remember:

```go
type Nudge struct {
    Title       string
    Text        string
    Restrictive bool
}

type Decision struct {
    Action      Action
    Title       string // neutral title for Soften; original for Allow; "" for Suppress
    Text        string
    ShowSupport bool
    Reason      string
}
```

`softenedTitle` is a package constant alongside `softenedText`.

### Text stays deterministic

The mockup's *"one more Greek yogurt closes the gap"* implies a food suggestion. `Context.Usual` could source one truthfully, but PR 1 leaves it out: the package invariant is that every value traces back to a repository read, and that should not be weakened for copy.

Accepted copy deviation from the mockup:

| Kind | Title | Text |
|---|---|---|
| `protein` | `Protein` | `142 / 160g — 18g to go` |
| `fibre` | `Fibre is low` | `Under target 4 days running` |
| `weight_trend` | `Weight trend` | `Down 1.8kg over 30 days` |

**Weight-trend window is 30 days, not the 7-day nutrition window.** A 7-day weight delta is mostly water-weight noise, and the mockup says "this month". It uses the existing `tracking.Repository.WeightSeries(ctx, userID, from, to)` read, surfaced on `Context` as a new grounded field so the "every value traces back to a repository read" invariant holds. With fewer than two weight entries in the window there is no trend to state and the candidate is omitted rather than guessed.

**The mockup's projection is dropped.** *"on pace for 75kg in ~6 weeks"* is a forecast, not a logged number, and it frames a weight-loss goal — both reasons to leave it out. Text states the observed delta only.

### API-widening safety

`guardrails` currently has exactly one consumer (`coach`), so adding `Title` to `guardrails.Nudge`/`Decision` breaks no other package. Note `service.go:141` builds a `guardrails.Nudge` for the **Ask** path: it passes an empty `Title` and ignores `Decision.Title`, since answers are not titled cards. Empty must stay valid.

### Tests

- `Kind`/`Title` present and correct per candidate.
- Weight-trend candidate **absent** when `AtRisk(signals)` is true, present when false — one test per risk threshold.
- `Soften` neutralises **both** title and text (add a restrictive fixture; none exists today).
- Existing `TestBuildNudges_NoSurvivingRestrictiveUnderRisk` still passes.

---

## PR 2 — Thread persistence (store + replay)

### Migration `000018_coach_turns`

Follows the `saved_meals` idiom (`gen_random_uuid()`, cascade on user, `ix_` index prefix):

```sql
CREATE TABLE coach_turns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,                          -- 'user' | 'otto'
    text       TEXT NOT NULL,
    citations  JSONB NOT NULL DEFAULT '[]'::jsonb,     -- otto turns only
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_coach_turns_user_created ON coach_turns (user_id, created_at);
```

Citations live in `JSONB`, not a child table — display-only, never queried, so a join buys nothing.

**Migration hygiene:** verify `coach_turns` is not already created by an earlier migration before adding this file, and run the full chain against a fresh database. This is exactly the failure PR #56 fixed.

### Endpoint

`GET /v1/coach/thread` → `{turns: [{role, text, citations, created_at}], show_support}`.

Ordering is explicit: select the **50 most recent** turns by `created_at DESC`, then return them **oldest→newest** so the client renders top-to-bottom without reversing. A user with more than 50 turns sees their most recent 50, not their first 50.

### Behaviour

1. **`show_support` is never stored.** Recomputed from current signals on every response including `/thread`. Persisting it would let a stale risk flag reappear, or a cleared one keep showing. Risk state is always live.
2. **Budget-degraded replies are not persisted.** When the meter is exhausted `/ask` returns 200 with `"I've hit today's usage limit — try again later."`. That is a UI state, not a turn; storing it leaves permanent dead text mid-thread. The user turn is not stored either, so nothing is silently swallowed.
3. **Both turns commit in one transaction.** A provider failure stores nothing — no orphaned question without an answer.
4. **The opening greeting is client-side and not persisted.** The mockup's dynamic *"Morning, Alex. You're trending well"* would otherwise pollute the table and later read as something Otto said months ago.

Retention is capped on read; the table grows unbounded. Acceptable for a friends-and-family beta — pruning is a noted follow-up, not built now.

### Package layout

`api/internal/coach/` gains `thread.go` (model + repository) and handler/service methods, matching the existing `handler.go` / `model.go` / `repository.go` / `service.go` split with a `_test.go` per file.

### Tests

- Round-trip: `/ask` writes both turns; `/thread` replays them oldest→newest.
- Cap: 51 turns stored → 50 returned, most recent.
- Budget-exhausted `/ask` stores nothing.
- Provider error stores nothing (no orphaned user turn).
- `show_support` reflects current signals, not stored state.
- Turns are user-scoped: another user's turns are never returned.

---

## PR 3 — Mobile UI

Stack: Expo Router 57, React Native 0.86, TanStack Query v5, `apiFetch` from `@/lib/api`.

**`apps/mobile/AGENTS.md` requires reading `https://docs.expo.dev/versions/v57.0.0/` before writing code — Expo APIs have changed.**

### Files

```
app/coach.tsx                              pushed stack route
src/components/coach/FocusCard.tsx         icon + title + body, variant-styled
src/components/coach/SupportCard.tsx       show_support resource card
src/components/coach/Bubble.tsx            otto / user chat bubble
src/components/coach/CitationChips.tsx     chips under otto bubble
src/components/coach/SuggestionChips.tsx   canned prompts
src/components/coach/AskInput.tsx          text input + send
src/components/coach/nudgeVisual.ts        Kind -> icon + hue + variant map
src/components/home/CoachEntryCard.tsx     home entry card
```

Per the repo's file-organisation rule (many small focused files), each component is its own file. `nudgeVisual.ts` isolates the only presentation mapping so it can be unit-tested without rendering.

### API layer

`src/api/types.ts` gains `CoachNudge`, `CoachKind`, `CoachTurn`, `CoachCitation`, `CoachNudgesResponse`, `CoachThreadResponse`, `CoachAnswer`.

`src/api/hooks.ts` gains:

- `useCoachNudges()` — `useQuery(["coach","nudges"])`
- `useCoachThread()` — `useQuery(["coach","thread"])`
- `useCoachAsk()` — `useMutation`; on success appends to the thread cache and invalidates `["coach","nudges"]` (an answer can change the numbers a nudge is derived from)

Types are explicit on these exported functions per the TypeScript style rule; no `any`.

### Behaviour

- Focus cards render from `nudges`, ordered as the server returns them.
- `show_support` true → `SupportCard` above the focus cards. Never replaces them: the backend already suppresses restrictive nudges under risk, so survivors are safe by construction.
- Empty thread → client-side greeting; not persisted.
- Send → optimistic user bubble, pending indicator on Otto's side, then the real answer with citation chips.
- Suggestion chips fill the input and send.
- Zero nudges → the focus section is omitted entirely rather than showing an empty header.

### Error handling

| Case | UI |
|---|---|
| `/nudges` fails | focus section hidden, thread still usable; non-blocking inline retry |
| `/thread` fails | greeting + working input; thread area shows retry |
| `/ask` fails | user bubble stays, Otto bubble shows an inline error with retry; input keeps the text so it is not lost |
| budget exhausted (200) | rendered as a normal Otto reply — it already carries a human message |
| offline | send disabled with a clear reason (`#22` offline queue is separate scope) |

No error is swallowed; every failure has a user-visible message and a way forward.

### Accessibility & fidelity

- Reviewed side-by-side against `CoachScreen.jsx` before merge (UI-fidelity gate).
- Icons carry accessible labels; chips and send are real touchables with adequate hit targets.
- Bubbles use theme tokens from `@/theme`, not hardcoded colours.

### Tests

- `nudgeVisual` maps every `CoachKind`, including an unknown-kind fallback (forward-compatible with a 4th kind).
- `FocusCard`, `SupportCard`, `Bubble`, `CitationChips` render tests.
- `app/coach.tsx`: nudges + thread render; send appends turns; `show_support` shows the card; each error path renders its retry.
- `CoachEntryCard`: shows top nudge, navigates, renders nothing when there are no nudges.

---

## Out of scope

- Multi-turn grounding (prior turns fed to the model) — deliberately excluded; widens the guardrail surface and grows per-call tokens.
- `#22` offline queue.
- Nudge copy sourced from `Context.Usual` (food suggestions).
- `coach_turns` retention pruning.
- Follow-ups already filed against #51: `FastingStreakDays` counting today's partial day, `RecentDeficitPct` applying today's target across the 7-day window, and `looksRestrictive` being a coarse substring lexicon.
