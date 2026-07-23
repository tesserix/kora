# Kora — Open Questions & Design Decisions

This document tracks the hard decisions the [Product Spec](./PRODUCT_SPEC.md) leaves open.
The spec defines **what** Kora does; this defines **how** it actually works and what still
needs to be decided. Keep the spec as the vision; resolve these before/while building.

Status legend: 🔴 unresolved · 🟡 proposed · 🟢 decided

---

## 1. Nutrition Accuracy & Confidence 🔴

The spec says "never hallucinate" but does not define the mechanism.

- **Confidence tiers.** Only `>90%` and "low" are defined. Proposed:
  - `≥ 90%` → auto-suggest, one-tap log
  - `70–90%` → show result + one quick confirm ("Grilled or fried?")
  - `< 70%` → ask targeted follow-ups before logging
- **AI → database mapping.** How does a free-text/vision guess ("chicken biryani") resolve
  to a canonical database entry? Fuzzy match + ranking? Human-verified alias table?
- **Portion error bars.** `620 kcal` implies false precision. Should display as a range
  (e.g. `~600 kcal ±15%`) with the ability to tighten it.
- **Unknown foods.** Behaviour when a dish/food is in **no** database (novel, regional,
  homemade). Fall back to ingredient decomposition? Flag as estimate?

## 2. Correction & Edit Loop 🔴

The spec covers logging thoroughly but barely covers *fixing* — the #1 abandonment driver.

- How does a user edit a portion/food **after** it's logged?
- Can corrections re-run the AI, or only manual edit?
- Do corrections **teach** the model (feeds Personal Food Memory §4)?
- Undo / delete a log entry.

## 3. Offline & Failure Behaviour 🔴

Camera, voice, and chat all depend on network + AI availability.

- What works offline? Proposed: **barcode + manual + queued logs** work offline;
  photo/voice/chat queue and process when back online.
- Behaviour when the AI provider is down or slow → fallback model? Manual entry path?
- Restaurant / poor-signal scenario (the exact moment users most want to log).

## 4. Onboarding & Cold Start 🔴

No first-run experience is specified. The app is weakest before it has any user data.

- Goal selection → TDEE / macro target calculation (which formula? Mifflin-St Jeor?).
- Health integration connect flow.
- Empty states before Personal Food Memory, Insights, and trends have data.

## 5. Data Model 🟡

Draft core entities to prevent backend churn:

- `User` — goals, targets, preferences, connected integrations
- `FoodLog` — a logged consumption event (time, source: photo/chat/voice/barcode/manual)
- `FoodItem` — canonical nutrition record (sourced from USDA/OFF/AU DB)
- `Recipe` — user recipe → computed per-serving macros
- `Meal` — grouping of food items (a "usual breakfast")
- `Supplement`, `WeightEntry`, `WaterEntry`, `FastingSession`
- Relationships: a `FoodLog` references either a `FoodItem`, a `Recipe`, or an ad-hoc estimate.

## 6. AI Cost & Latency Budget 🔴

Every photo is a vision-model call — the largest cost and latency line at scale.

- Target latency: photo → result should feel instant (**< 3s**), chat < 1.5s.
- Caching: identical barcodes and previously-seen foods must **not** re-hit the LLM.
- Per-user monthly inference budget assumption (drives pricing, §9).
- When to use Gemini Flash Lite vs 2.5 Flash vs GPT-5 mini fallback (routing rules).

## 7. Privacy & Security Specifics 🔴

"End-to-end encrypted images" conflicts with "AI analyses your photos" — the server must
decrypt to run vision. Needs precise language.

- Proposed: encrypted **in transit and at rest**; decrypted **transiently** for inference;
  original image deleted or retained per user setting.
- Health-data regulatory posture (GDPR; HIPAA-adjacent handling of health metrics).
- Data residency — AU-first launch (see §10) implies AU/US residency questions.

## 8. Medical Safety & Guardrails 🔴

The app touches diabetes goals, fasting, weight prediction, and calorie limits.

- Explicit non-medical disclaimer surface.
- Eating-disorder guardrails: messaging like "you've eaten enough calories" can harm
  vulnerable users. Detect risky patterns; soften or suppress restrictive nudging.
- Weight-trend **predictions** must be framed as estimates, never promises.

## 9. Monetisation 🔴

Not mentioned in the spec, but AI inference has real per-user cost — free-forever isn't viable.

- Proposed freemium: free = manual + barcode + basic dashboard;
  paid = AI photo/chat/voice, coach, meal planner, insights.
- Pricing tier and trial. Impacts §6 architecture (rate limits, model routing).

## 10. Scope, Phasing & Launch Market 🟡

20 core + 15 future features is a multi-year roadmap. Define shipping order.

- **Proposed V1 (MVP):** AI photo logging, chat logging, daily dashboard, barcode, weight
  tracking, basic onboarding.
- **V2:** voice, personal food memory, recipes, restaurant mode, AI coach, insights.
- **V3+:** everything else + Future Features from the spec.
- **Launch market.** "Australian Food Database" + flat white / Nandos signals **AU-first**.
  Confirm — it cascades into units (kg/ml), currency (restaurant spending), and food DBs.

## 11. Success Metrics 🔴

"Easiest ever" must be measurable or it's unfalsifiable. Proposed north-star + guardrails:

- **Median time to log a meal < 10s.**
- % of meals logged with **zero manual correction**.
- D1 / D7 / D30 retention.
- % of logs by source (photo/chat/voice/barcode/manual) — validates the conversational thesis.

## 12. Smaller Notes 🟡

- **Accessibility** — voice-first is a strength here; make VoiceOver + Dynamic Type explicit.
- **Localization** — units, currency, date formats, and food DB selection follow from §10.

---

_When a question is resolved, mark it 🟢, record the decision inline, and reflect any
user-facing change back into `PRODUCT_SPEC.md`._
