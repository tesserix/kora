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

## 13. Brand-level Australian chain data 🟡 — FatSecret ruled out 🟢

The index answers "pizza, takeaway" with an AUSNUT survey category but has **no
Australian chain brands**. Measured 2026-08-18: McDonald's 45 rows, all US;
KFC 23 US / 1 AU; Grill'd, Guzman y Gomez, Zambrero, Red Rooster, Hungry
Jack's and Oporto **zero**. AUSNUT names survey categories, never brands
("Pizza, meat & vegetable (e.g. supreme), takeaway"), so no amount of work on
the Australian government sources closes this.

**The gap is still open.** What is decided is that FatSecret does not close it.

### FatSecret — ruled out 2026-08-18 🟢

Auth works (OAuth2 client-credentials, `scope=basic`, tokens issue fine). Data
access is IP-allowlisted and was never granted, so no AU query was ever run.
Ruled out on its **terms**, which no allowlist would change:

- **Content must be deleted or re-requested within 24 hours** unless explicitly
  marked storable indefinitely (Terms 1.5). This is the decisive one: FatSecret
  can never be an ingest source feeding `food_items`. It could only ever be a
  runtime lookup with a short cache — inside the 1.5 s resolve budget, on every
  request, for a food the index cannot answer.
- **Attribution is permanent.** Every surface displaying Content must credit
  FatSecret, and the attribution links must be retained *even after you stop
  using the API* (Terms 1.3).
- **5,000 calls/day** on the free tier, not carried over.
- The application may not operate only behind a firewall or on an internal
  network outside development and testing.

Separately, and less firmly: **AU localization appears to be a paid Premier
feature.** FatSecret's FAQ twice groups it with Premier — "any Premier
capabilities *or localization to supported countries*", "any of our Premier
features *or localized data sets*" — and the "58+ countries" claim sits in
Premier's feature list. This is documentation, **not measured**: the IP block
stops every query before region is evaluated. It is a reason not to expect much
from the free tier, not proof.

Do not re-attempt the free tier. If AU brand coverage becomes a priority, the
question is commercial — whether a paid Premier agreement is worth it — and the
architecture it buys is still a runtime lookup, not an ingest source.

### What is NOT ruled out

- Per-chain menu data, negotiated or licensed directly.
- Any source whose terms permit storage. OpenFoodFacts already works this way
  (ODbL, attribution required, storage fine) but is packaged-goods only.
- Accepting the gap: answer chain queries with the generic AUSNUT row and be
  honest that it is a category estimate.

Prior art that failed, so it is not retried: FoodSwitch is packaged-only; the
chains publish JavaScript calculators rather than tables, and six fetch
attempts across two methods returned nothing usable.

---

_When a question is resolved, mark it 🟢, record the decision inline, and reflect any
user-facing change back into `PRODUCT_SPEC.md`._
