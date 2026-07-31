# Design — Kora in-app feedback (R1)

**Date:** 2026-07-31
**Status:** approved (design)
**Milestone:** R1 — Friends & family beta

## Problem

R1 puts Kora in the hands of ~10–30 friends and family. When they hit a bug or want something, there is currently no way to tell us from inside the app — it goes to a text message, or nowhere. For a beta whose entire purpose is signal, that is the wrong default.

## Decision

**Store feedback in Kora's own database, in a shape that deliberately mirrors mark8ly's live `marketplace-api` ticket contract.**

mark8ly serves its own support tickets from its own `marketplace-api` — `subject`, `description`, `status` (`open` / `in_progress` / `resolved` / `closed`), and a reply thread. `tesserix/tickets-service`, a separate platform-engineering service modelled on the same shape, is deployed nowhere and used by nothing; it does not surface mark8ly's tickets or anyone else's. Kora deliberately follows mark8ly's pattern instead: each product owns its own table, rather than depending on a shared ticket service that does not exist in the running system.

So: capture locally, shaped for a later mechanical mapping to the pattern any future admin integration will most likely mirror, rather than a redesign.

### Field mapping to mark8ly's `marketplace-api` ticket contract

Every column exists to line up with mark8ly's live `Ticket` model, so integration is a projection:

| Kora `feedback` | mark8ly `marketplace-api` `Ticket` |
|---|---|
| `id` | `id` |
| `kind` (`bug` \| `feature`) | — (no mark8ly equivalent; Kora's own) |
| `subject` | `subject` |
| `description` | `description` |
| `status` (`open` \| `in_progress` \| `resolved` \| `closed`) | `status` (identical) |
| `user_id` | — (reporter identity) |
| `app_version`, `platform`, `os_version`, `device_model` | — (no mark8ly equivalent) |
| `created_at` | `created_at` |

`ticket_number`, `submitted_by_name` / `submitted_by_email`, and `replies` all exist on mark8ly's `Ticket` and are deliberately **not** stored here: this table is capture-only, with no ticket numbering, no submitter-identity fields beyond `user_id`, and no reply thread.

`tenant_id` / `product_id` are deliberately **not** stored either. Kora is a single-product consumer app with no tenancy concept; inventing a column now would be speculative. They would be constants supplied at integration time, if one is ever built.

`priority` is also not captured. Asking a beta user to self-triage produces noise, not signal.

## Scope

**In:** a `POST /v1/feedback` endpoint, the table, and a mobile entry point that lets a user file a bug or a feature request.

**Out (deliberate):**
- Any tesserix-home / admin integration — that is a later phase this design is shaped for, if it happens at all.
- Comments, attachments, assignees, SLA, status transitions. All exist on mark8ly's `Ticket`; none belong in a capture-only store.
- A user-facing list of past submissions. Nice, but it is not what makes the beta useful, and it doubles the UI surface.

## Client context is captured server-side where possible

`app_version`, `platform`, `os_version` and `device_model` make a bug report actionable — "it crashed" versus "it crashed on iOS 26.1, app 1.0.0". The client sends them; the server does not trust them for anything but display, and they are length-capped like every other field.

## Safety and abuse

- Fields are length-capped and the request body is bounded, exactly as `POST /v1/coach/ask` now is. Feedback writes to an unbounded table, so this is the same class of exposure.
- Feedback is user-scoped: a user may only create rows as themselves, taken from the auth context, never from the request body.
- No rate limit in R1. At 10–30 known users it is not the risk; note it before any public exposure.

## Testing

- Round-trip: create → row present with the right kind, subject, description, status, reporter.
- `kind` is validated against the allowed set; anything else is a 400 `invalid_input`.
- Empty or whitespace-only subject/description rejected.
- Over-length input rejected with 400, not truncated silently and not a 500.
- The reporter always comes from the auth context — a `user_id` in the request body is ignored.
- Unauthenticated requests get 401.
