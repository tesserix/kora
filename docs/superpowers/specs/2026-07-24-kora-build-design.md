# Kora — Build Design

**Date:** 2026-07-24
**Status:** Approved
**Sources:** [PRODUCT_SPEC.md](../../PRODUCT_SPEC.md) · [OPEN_QUESTIONS.md](../../OPEN_QUESTIONS.md) · `design-system/` (tokens + Kora UI kit mockups)

Kora is an AI-powered nutrition tracking app for iOS and Android. The goal is not another
calorie tracker — it is the easiest nutrition tracking experience ever built: photo, chat,
voice, barcode, and manual logging that feel conversational rather than like data entry.

---

## Decisions Locked

| Decision | Choice |
|---|---|
| Scope | Full core spec — all 20 core features, phased within this one plan |
| Backend shape | Modular Go monolith (one service, domain packages, one Postgres DB) |
| Deployment | Existing Tesserix GKE Autopilot cluster (Knative, ArgoCD, ESO) via `tesserix-k8s`, following the postiz pattern |
| Launch market | AU-first — metric units, AUD, AFCD + OpenFoodFacts prioritized, USDA fallback |
| Monetisation | Metering + entitlements designed in from day one; paywall (RevenueCat) ships in the final phase |
| Sequencing | Vertical slices (usable app every phase) with a dedicated early phase for the AI nutrition-resolution engine, gated by an eval harness |

These resolve OPEN_QUESTIONS §5 (data model), §6 (cost budget mechanism), §9 (monetisation),
§10 (scope + market). §1–§3, §7, §8 are resolved by the designs below. Reflect these back
into OPEN_QUESTIONS.md (mark 🟢) as phases land.

---

## 1. System Architecture

### Repo layout (`kora/`, this repo)

```
kora/
├── apps/mobile/       # Expo (React Native) app — TypeScript, Expo Router
├── api/               # Go modular monolith — Gin, GORM, Postgres, Redis
├── design-system/     # (exists) tokens + web mockups; visual source of truth
├── docs/              # spec, open questions, design docs
└── infra/             # Dockerfiles, docker-compose for local dev
```

Production manifests live in `tesserix-k8s` (deployment/Knative service, ExternalSecret,
VirtualService, ArgoCD app) so the kora repo stays app-only.

### Go monolith (`api/`)

```
api/
├── cmd/api/main.go
└── internal/
    ├── auth/          # Firebase Auth JWT verification middleware
    ├── foodlog/       # log CRUD, diary, corrections/undo, edit history
    ├── nutrition/     # ★ resolution engine: AI guess → canonical FoodItem
    ├── ai/            # provider clients (Gemini 2.5 Flash / Flash Lite, GPT-5 mini fallback), routing, caching
    ├── memory/        # personal food memory (patterns, usuals)
    ├── recipes/       # recipe import (photo / paste / URL) → per-serving macros
    ├── restaurants/   # chain search + nutrition import
    ├── coach/         # AI coach (Otto): nudges + conversation + safety guardrails
    ├── insights/      # weekly reports (async generated)
    ├── tracking/      # weight, water, supplements, fasting
    ├── planner/       # AI meal planner + shopping lists
    ├── integrations/  # health providers behind one interface (Apple Health, Google Fit, …)
    ├── social/        # shares, streaks
    ├── gamification/  # XP, levels, badges, challenges, consistency score
    └── billing/       # usage metering + entitlements (paywall late, metering day one)
```

- One Postgres database (GORM + golang-migrate).
- Redis: nutrition-lookup cache + asynq queue for slow AI jobs (photo analysis, insight
  generation) — the API never blocks on inference.
- All AI keys are server-side only; the app never calls Gemini directly.
- Follows the established Tesserix Go conventions: Gin, handler/service/repository layers,
  JSON error envelope, structured logging, `/health` + `/ready`.

### Mobile app (`apps/mobile/`)

- Expo + Expo Router + TypeScript; Zustand for client state, React Query for server state.
- The design system's components are **web JSX** and cannot be imported into React Native.
  The `design-system/tokens/` (OKLCH colors, type, spacing, radius, motion — locked Iris
  theme) are ported to a RN theme module; the UI-kit mockup screens are the visual spec and
  native primitives (Button, Card, CircularProgress, Progress, Stat, Badge, tab bar, sheet)
  are re-implemented against those tokens.
- Camera + barcode: `expo-camera`. Voice: native speech-to-text feeding the chat pipeline.
- Offline behaviour (OPEN_QUESTIONS §3): barcode + manual logging work fully offline;
  photo/voice/chat capture is queued and processed on reconnect. Sync queue persisted on
  device.
- Dark mode + light mode from tokens. Accessibility baseline: VoiceOver, Dynamic Type,
  reduced motion.

## 2. Data Model

- `User` — profile, goal, computed targets (TDEE via Mifflin-St Jeor → macro targets),
  preferences, connected integrations, entitlement tier.
- `FoodItem` — canonical nutrition record with provenance (`afcd` / `off` / `usda` /
  `label_ocr` / `user_estimate`); FTS + pgvector embedding columns for resolution.
- `FoodAlias` — maps common names ("flat white") to canonical FoodItems; seeded for top AU
  foods, grown from user corrections.
- `FoodLog` — one consumption event: time, meal slot, source (photo/chat/voice/barcode/
  manual), portion, confidence tier, reference to **either** FoodItem, Recipe, or ad-hoc
  estimate; edit history preserved.
- `Recipe` — ingredients → computed per-serving macros; reusable.
- `Meal` — named grouping ("usual breakfast") for one-tap logging.
- `MemoryPattern` — learned habits powering "looks like your usual breakfast".
- `WeightEntry`, `WaterEntry`, `SupplementSchedule` + `SupplementLog`, `FastingSession`.
- `HealthSample` — imported weight/steps/sleep/heart-rate/workouts.
- `AIUsageEvent` — per-call metering (user, model, tokens, latency, cost) → budgets +
  entitlements.

Invariant: a `FoodLog` references exactly one of FoodItem / Recipe / estimate.

## 3. Nutrition Resolution Engine

Hard invariant: **the LLM never outputs nutrition numbers that get stored.** The LLM only
identifies *what* the food is; numbers always come from a database row (or an explicitly
flagged estimate assembled from database rows).

### Local food index

AFCD, OpenFoodFacts (AU slice + global barcodes), and USDA are ingested into Postgres as
`FoodItem` rows with full-text + embedding search. Barcode scans resolve directly against
the index and never hit an LLM.

When a barcode has no index entry (common for AU imports and local brands), the user can
photograph the nutrition panel: **nutrition-label OCR** parses it into a `FoodItem` with
`label_ocr` provenance, linked to the barcode — closing the dead-end and enriching the
index for every user.

### Resolution flow (photo, chat, voice converge here)

1. AI call returns structured guesses: `[{food, portion_estimate, cooking_method, confidence}]`.
2. Each guess resolves: alias hit → full-text → embedding similarity → ranked candidates.
3. Confidence tiers (resolves OPEN_QUESTIONS §1):
   - **≥ 90%** → auto-suggest card, one-tap log
   - **70–90%** → show result + one quick confirm ("Grilled or fried?")
   - **< 70%** → targeted follow-up questions before logging
4. Unknown foods → LLM decomposes the dish into index-resolvable ingredients; result is
   flagged `estimate` and displayed as a range (`~600 kcal ±15%`).
5. Corrections (§2 of OPEN_QUESTIONS) are first-class: edit portion/food after logging,
   undo/delete, re-run AI on request. Corrections update the alias table and the user's
   MemoryPatterns — the edit loop teaches the system.
6. **Provenance is visible in the UI**: every logged item carries a trust chip
   ("AFCD · verified" vs "AI estimate ±15%") so users always know where numbers came from.

### Model routing & cost (`ai/`)

- Gemini 2.5 Flash → vision. Gemini Flash Lite → chat parsing + coach. GPT-5 mini →
  automatic fallback on provider error/timeout.
- Redis cache keyed on barcode and normalized food phrase — repeats never hit an LLM.
- Every call writes an `AIUsageEvent`; per-tier monthly inference budgets enforced in
  `billing/`.
- Latency budgets: photo → result **< 3s** (streamed progress in UI), chat **< 1.5s**.

### Evaluation harness

Built in the engine phase, before any camera UI: a golden dataset of 100+ real food photos
and 200+ chat phrases with human-verified expected foods and macros. A `go test`-runnable
eval scores identification accuracy, resolution correctness, and calorie error. It is the
engine phase's exit gate and the permanent regression suite for every prompt/model change.

Initial exit-gate targets (tune once baselined, but never silently lower): top-1 food
identification ≥ 80% on photos, ≥ 90% on chat phrases; resolved-entry correctness ≥ 90%;
median calorie error ≤ 20% vs human-verified values; zero hallucinated nutrition rows.

### Safety & privacy guardrails

- Coach tone enforced by system prompt: supportive, evidence-based, never judgemental,
  never medical claims. Persistent non-medical disclaimer surface.
- Eating-disorder guardrails: a response filter suppresses restrictive-eating nudges when
  risky patterns are detected (rapid weight loss + sustained very low intake).
- Weight-trend predictions always framed as estimates, never promises.
- Images (resolves OPEN_QUESTIONS §7): encrypted in transit and at rest, decrypted
  transiently for inference, original deleted or retained per user setting. This is
  deliberately **not** described as end-to-end encryption.
- Users own their data: full export and account deletion (Phase 8).

## 4. Build Phases

Vertical slices — every phase ends with a working, demoable app on device.

### Phase 0 — Foundations
Scaffold `apps/mobile` (Expo Router + TS) and `api/` (Gin skeleton, GORM, migrations,
health endpoints, error envelope, logging). Firebase Auth end-to-end: device sign-in →
verified JWT in Go middleware. Port DS tokens to RN theme + build core native primitives
against the mockups. docker-compose (Postgres + Redis). CI (lint, test, build, image →
GAR) per existing workflow patterns. Dev deploy to GKE via `tesserix-k8s`.

### Phase 1 — Log food without AI
Food index ingestion pipeline (AFCD + OFF + USDA → FoodItem, FTS + embeddings). Onboarding
(goal selection → Mifflin-St Jeor TDEE → macro targets; integration connect prompts; empty
states). Manual food search + logging, barcode scanning, diary, daily dashboard (calorie
ring, macros, streak), water tracking quick-adds, offline queue. Fast-repeat affordances
from day one: **copy previous day** and **repeat any past meal** (one tap), plus
**backdated manual entry** ("I forgot yesterday"). Provenance trust chip on every logged
item. Success-metric instrumentation starts here (time-to-log, % logs by source,
% zero-correction logs). *(Features: 7, 12, 14, 16 + onboarding.)*

### Phase 2 — Nutrition resolution engine
Provider clients + routing + fallback, structured food identification, index resolution
with alias table, confidence tiers, ingredient decomposition, portion ranges, caching,
metering. **Exit gate: eval harness meets accuracy targets on the golden dataset.**
Minimal UI. *(The §1/§6 core.)*

### Phase 3 — Conversational logging
Camera capture → detection card → one-tap log (streamed, < 3s feel). Chat logging with
clarifying questions, including **retroactive logging** with natural-language dates
("yesterday I had biryani for lunch"). Voice logging (speech-to-text → chat pipeline).
**Nutrition-label OCR** as the barcode-miss fallback. Full correction / edit / undo loop
feeding the alias table. Stretch: share-sheet ingestion (share a photo / screenshot / URL
from any app into the capture pipeline); "ate half" second photo to adjust consumed
portion. *(Features: 1, 2, 3 + edit loop.)*

### Phase 4 — Memory & reuse
Personal food memory ("your usual breakfast", one-tap usuals). Custom recipes (photo /
paste / URL import → per-serving macros). Saved meals. Restaurant mode (chain search +
AI-matched nutrition, visual-analysis estimate fallback). **Zero-open logging**: home /
lock-screen widgets (jump-to-camera, water quick-add), meal-time notifications with a
one-tap *Log* action ("Lunch? Your usual chicken wrap →"), and voice-assistant shortcuts —
"Hey Siri, log a flat white" via iOS App Intents (shared plumbing with widgets/Shortcuts)
and Google Assistant App Actions on Android, feeding the same chat-parse pipeline — the
biggest levers on the < 10s time-to-log target. Stretch: leftovers awareness ("You logged half a pizza
yesterday — having the rest?"). *(Features: 4, 5, 6.)*

### Phase 5 — Body & habits tracking
Weight tracking (weight, body fat, muscle, waist, photos) with trend charts and
estimate-framed predictions. Supplements with daily reminders. Fasting mode with IF
schedules. Health integrations behind one provider interface — Apple Health + Google Fit
shipped; Garmin/Fitbit/Whoop/Oura slot in behind the same interface later. *(Features: 9,
11, 13, 15.)*

### Phase 6 — Coaching intelligence
AI coach (Otto): daily nudges + conversation grounded in the user's actual data. Weekly
smart insights report (async generated), culminating in a **weekly check-in with adaptive
targets**: TDEE recomputed from the user's actual weight trend + logged intake (not just
Mifflin-St Jeor), with coach-explained target adjustments — estimates, never promises.
AI meal planner (budget, cuisine, calories, protein, time, available ingredients) +
shopping lists. Safety guardrails land with the coach. *(Features: 8, 10, 17.)*

### Phase 7 — Engagement
Gamification: XP, levels, badges, weekly challenges, consistency score. **Streak
forgiveness** by design: one weekly "repair" for a missed day, so a single slip never
zeroes a long streak — punitive streaks contradict the never-shame ethos. Optional social
sharing (weight milestone, protein streak, workout streak, recipe — no calorie shaming).
Push notification system (supplement reminders, coach nudges, streaks). *(Features: 18, 19.)*

### Phase 8 — Launch readiness
Privacy surface: data export, account deletion, image-retention settings. Monetisation:
RevenueCat paywall on the already-built entitlements (free = manual + barcode + basic
dashboard; paid = AI photo/chat/voice, coach, planner, insights). Accessibility pass
(VoiceOver, Dynamic Type). Performance + AI-cost validation against budgets. Production
hardening, store assets, App Store / Play Store submission.
*(Feature: 20 + OPEN_QUESTIONS §9.)*

## 5. Cross-cutting

- **Testing:** TDD throughout. Go unit + integration tests (≥ 80% coverage), RN component
  tests, Maestro E2E for critical flows (onboarding, log-a-meal, barcode), AI eval harness
  as permanent regression suite.
- **UI fidelity (GATE):** every frontend screen must match its `design-system/ui_kits/kora/`
  mockup — layout, hierarchy, and the *intent* in each mockup's header comment (e.g. Home is
  a "conversational, Otto-led feed, NOT a calorie-tracker dashboard"). Build from the mockup,
  not a generic interpretation: use the real components it composes (circular ring via
  `react-native-svg`, `FoodTile`, editorial headline, capture hero, tab bar, `Sheet`,
  `ScreenHeader`). Every frontend phase is reviewed against its mockup screenshot before
  merge; a functional-but-off-design screen is a failed review, not a pass. Elements that
  depend on later-phase features (Otto coaching copy, camera/voice capture) ship as tasteful
  static placeholders that still match the mockup's shape.
- **Error handling:** every AI path has a non-AI fallback — manual entry always works.
  Provider down → fallback model → graceful "log it now, I'll fill in details later" queue.
- **Observability:** structured JSON logs, per-call AI latency/cost metrics from day one.
- **Success metrics (OPEN_QUESTIONS §11):** median time-to-log < 10s, % zero-correction
  logs, D1/D7/D30 retention, % logs by source — instrumented from Phase 1.

## Out of Scope (this plan)

Everything under "Future Features" in PRODUCT_SPEC.md (receipt scanning, pantry, CGM,
Apple Watch app, etc.), additional health providers beyond Apple Health + Google Fit, and
non-AU localization beyond sane locale defaults.
