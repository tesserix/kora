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

`go run ./cmd/aidecide` uses a fixed 26-case synthetic corpus. Set
`AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` and `KORA_EVAL_END_USER_TOKEN` through
the environment, as with `cmd/aieval`; never put credentials on the command
line. The user token must be valid for the deployed gateway. The command emits
JSON, preserves failed cases and exits nonzero unless every check passes.

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
