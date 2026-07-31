# Design — Kora in-app feedback (R1)

**Date:** 2026-07-31
**Status:** approved (design)
**Milestone:** R1 — Friends & family beta

## Problem

R1 puts Kora in the hands of ~10–30 friends and family. When they hit a bug or want something, there is currently no way to tell us from inside the app — it goes to a text message, or nowhere. For a beta whose entire purpose is signal, that is the wrong default.

## Decision

**Store feedback in Kora's own database, in a shape that deliberately mirrors the platform `tickets-service` contract.**

`tickets-service` already models exactly this — `TicketTypeBug` / `TicketTypeFeature`, per-application scoping (`platform`, `mark8ly`, `fanzone`) and a `RegisterApplications` hook that would accept `kora`. tesserix-home reads it, which is how mark8ly's tickets surface in admin.

It is **not deployed in the cluster**. Posting to it from Kora would mean standing up the service, its database, a network policy, and cross-namespace service-to-service auth — a large infra lift inside the R1 window, for a feature whose value is simply *capture the signal now*.

So: capture locally, shaped for a later mechanical mapping rather than a redesign.

### Field mapping to `tickets-service`

Every column exists to line up with a `Ticket` field, so integration is a projection:

| Kora `feedback` | `tickets-service` `Ticket` |
|---|---|
| `id` | `id` |
| `kind` (`bug` \| `feature`) | `type` (`BUG` \| `FEATURE`) |
| `title` | `title` |
| `body` | `description` |
| `status` (`open`) | `status` (`OPEN`) |
| `user_id` | `created_by` |
| `app_version`, `platform`, `os_version`, `device_model` | `metadata` (JSON) |
| `created_at` | `created_at` |
| — (constant at integration time) | `application_id = "kora"`, `product_id`, `tenant_id` |

`tenant_id` / `product_id` are deliberately **not** stored. Kora is a single-product consumer app with no tenancy concept; inventing a column now would be speculative. They are constants supplied at integration time.

`priority` is also not captured. `tickets-service` defaults it to `MEDIUM`, and asking a beta user to self-triage produces noise, not signal.

## Scope

**In:** a `POST /v1/feedback` endpoint, the table, and a mobile entry point that lets a user file a bug or a feature request.

**Out (deliberate):**
- Any tesserix-home / tickets-service integration — that is the later phase this design is shaped for.
- Comments, attachments, assignees, SLA, status transitions. All exist in `tickets-service`; none belong in a capture-only store.
- A user-facing list of past submissions. Nice, but it is not what makes the beta useful, and it doubles the UI surface.

## Client context is captured server-side where possible

`app_version`, `platform`, `os_version` and `device_model` make a bug report actionable — "it crashed" versus "it crashed on iOS 26.1, app 1.0.0". The client sends them; the server does not trust them for anything but display, and they are length-capped like every other field.

## Safety and abuse

- Fields are length-capped and the request body is bounded, exactly as `POST /v1/coach/ask` now is. Feedback writes to an unbounded table, so this is the same class of exposure.
- Feedback is user-scoped: a user may only create rows as themselves, taken from the auth context, never from the request body.
- No rate limit in R1. At 10–30 known users it is not the risk; note it before any public exposure.

## Testing

- Round-trip: create → row present with the right kind, title, body, status, reporter.
- `kind` is validated against the allowed set; anything else is a 400 `invalid_input`.
- Empty or whitespace-only title/body rejected.
- Over-length input rejected with 400, not truncated silently and not a 500.
- The reporter always comes from the auth context — a `user_id` in the body is ignored.
- Unauthenticated requests get 401.
