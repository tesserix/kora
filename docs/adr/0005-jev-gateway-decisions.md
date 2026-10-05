# Jev decisions through the private Kora gateway

Status: client and synthetic probe implemented; production integration and shadow promotion pending.
Related: #560, #561, #562.

## Decision

Use Jev for bounded judgments over text or structured evidence. Kora retains
authorization, quota, arithmetic, safety checks and explicit user confirmation.
Jev cannot read image/PDF bytes or produce customer-facing prose. The existing
nutrition coach remains responsible for grounded explanations.

`internal/ai/decide` sends `kora-decide` to the private gateway's
`POST /v1/decisions`. The gateway translates to TypeSafe `/v1/systemone`, pins
the provider model and injects the OpenBao-sourced provider credential. The
application receives no TypeSafe key and cannot configure a direct vendor URL.
The route uses gateway API-key authentication and the existing verified user
identity. No redirect or application retry is allowed.

The client supports Choice, Score and Noul. Noul has no separate confidence
field. Score can be fractional. Unknown choices, incomplete answer maps,
invalid/null probabilities, missing usage, aliases in the resolved-model field,
out-of-range values and oversized responses are rejected. Errors never include
provider bodies, prompts, credentials or transport error details.

Requests are limited to 16,000 serialized bytes and 16 questions, with at most
255 options/levels. This deliberately stays below the vendor's token limits
without estimating unknown tokenization. Responses are capped at 64,000 bytes.
Every call has a 1.5-second deadline and one attempt. A `jev.decide` span records
the resolved model and token usage, never state or answers.

## Initial validation

`go run ./cmd/aidecide` uses a fixed 80-case synthetic corpus. Set
`AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` and `KORA_EVAL_END_USER_TOKEN` through
the environment, as with `cmd/aieval`; never put credentials on the command
line. The user token must be valid for the deployed gateway. The command emits
JSON, preserves failed cases and exits nonzero unless every raw model check and
every deterministic label check passes. `passed` remains the raw-model result;
`guarded_labels_passed` reports the separate numerical policy checks. Per-case
`actual`, `result` and `passed` never change when a guard corrects an answer.
The full run has a two-minute budget; each model call still has a 1.5-second
deadline and no application retry.

The test checks missing mass/volume, explicit grams/ml/servings, blank or
unreadable labels and a vague portion. It also checks intent routing (including
negation, hypothetical meals, Hindi and injected instructions) and candidate
matching (raw/cooked distinctions, ambiguity, missing matches and order changes). It is a functional smoke test, not an
accuracy/calibration benchmark, and does not send production documents. Do not
use a small synthetic suite as evidence for automatic nutrition decisions.

The client and command have deterministic HTTP contract tests. A live synthetic
probe through the deployed gateway software version (1.4.1), running locally,
passed eight of eight cases against `jev-1.13.0`. This is not evidence that the
new Kubernetes route has been rolled out or that Firebase admission passed.

## Hard-case findings and measurement policy

The production gateway is now deployed and authenticated synthetic calls have
verified the route. Harder tests exposed a different problem: Jev sometimes
approved negative quantities, missing units, incompatible mass/volume units,
and missing label bases. One wrong answer had 0.80 confidence. A confidence
threshold cannot establish numerical correctness.

`labelocr.PlanConsumption` owns measurement eligibility and scaling. It accepts
a checked `Label` and an explicit `Consumption`, and returns one of:

- `retake`: label basis or essential energy evidence is unavailable/non-finite.
- `review`: unresolved OCR issues, low confidence or invalid nutrition remain.
- `ask_amount`: quantity is missing, non-positive, conflicting, non-finite, has
  incompatible units, or cannot be scaled without overflow/underflow.
- `calculate`: compatible evidence permits a deterministic nutrition preview.

The source must come from trusted application orchestration of `labelocr.Check`,
not an arbitrary client-supplied `Label`. OCR partial/review status must become a
review issue in the future evidence adapter. Consumed amount is customer input,
never inferred from printed serving size. Cross-dimension conversions require
additional verified evidence and currently ask for a compatible unit; density
is never assumed. Unknown nutrients remain null. A zero-energy label is valid.
`calculate` is a preview, not authorization to save; customer confirmation,
ownership and quota enforcement remain product-integration requirements.

For the synthetic evaluator only, `guard.go` adapts both historical fixture
schemas into that policy. This adapter is not an OCR ingestion endpoint. It
does not take a model answer, so neither confidence nor prompt injection can
override the measurement checks. The policy remains usable if Jev times out;
raw model failures still fail the evaluation command.

Intent criteria now distinguish the author's consumption from quoted examples,
third-person reports, grammar/translation questions, future meals and negation.
Candidate criteria explicitly preserve brand and preparation distinctions.
These are advisory semantic decisions and cannot authorize diary mutations.

Validation on 2026-10-05: revised semantic criteria passed 48/48 fixed hard-case
calls, then 72/72 calls over 24 additional examples fixed before testing. The
compiled Go client subsequently passed 52/56 raw checks; its four incorrect
numeric decisions were all corrected by the guard, which passed 22/22 label
cases. These synthetic figures are not production-population accuracy estimates.
Original prompts, expected answers and failed reports were retained locally.
The extra examples are now retained in the 80-case repository corpus.

This is a local deterministic policy with no new service, datastore, network
call, migration or retry. It adds no provider cost and can avoid an entire model
call when a future product caller only needs a measurement decision. No new
capacity/SLO assumption is needed for the existing bounded evaluator. A prompt-
only fix was rejected because numerical failures recur across schemas. Revert
this scoped change to roll back; it changes no stored user data. The customer
OCR-to-agent-to-app integration and API deployment hold remain unchanged.

## Production integration gates

1. Deploy the gateway route, exact OpenBao reader and Registry-managed resource
   bundle through their owning GitOps repositories. Verify authentication,
   identity stripping, response semantics and private-only access on the actual
   route. Keep Kora's unrelated API deployment hold intact.
2. Confirm provider privacy/retention admission before sending real user data.
   Enterprise zero-retention availability is not a default guarantee.
3. Preserve immutable OCR identity, citations, units, partial status and missing
   quantities. The current label adapter discards evidence needed downstream.
4. Add the product caller with quota enforcement, per-attempt `ai_usage_events`
   accounting, cancellation and a deterministic clarification/review fallback.
   The standalone client is not yet wired into user requests or that ledger.
5. Shadow each decision against independent labels and user confirmations.
   Pin the model, question set and policy versions. Record precision/coverage,
   calibration, language/quality segments, latency and total cost before enabling
   any decision. No arbitrary confidence threshold enables auto-saving.

## Failure and rollback

Unconfigured clients return `ErrNotConfigured`; invalid identity, contract or
upstream responses return typed failures. Callers must keep their existing
safe path, which means asking or reviewing when required data is missing, not
inventing a portion. Disable the consuming feature to roll back without
changing OCR evidence or diary entries. Do not retry 400/401/403/422 responses.

TypeSafe documents arithmetic, option-order and adversarial-state limitations.
OCR text remains untrusted. Numerical conversion and citation membership stay
deterministic; model confidence cannot bypass allergy/medical gates. See
https://docs.typesafe.ai/model-jaggedness/jev-1.13 and
https://docs.typesafe.ai/confidence.
