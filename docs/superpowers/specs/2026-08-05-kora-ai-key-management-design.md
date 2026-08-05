# Design — Kora AI provider key management

Date: 2026-08-05. Touches `tesserix-home` (pages + Secret Manager and
Kubernetes clients) and `tesserix-k8s` (RBAC). **Does not touch `kora-api`.**

**Status: designed with the user, decisions recorded below.**

## Purpose

Rotate Kora's AI provider keys from the admin portal, and see their state
without going to the GCP console.

This is a **different subsystem from food data administration**, sharing only a
nav section. Food data flows through kora-api's signed BFF; keys flow through
GCP Secret Manager → ExternalSecret → pod environment variable. Different
backend, different auth, different failure mode. They are specified separately
on purpose.

## The awkward truth this design exists to handle

Kora's keys reach the process as **pod environment variables**, delivered by the
`kora-api-secrets` ExternalSecret with a **1h `refreshInterval`**. So writing a
new Secret Manager version changes nothing:

1. The version exists in Secret Manager — the pod still has the old key.
2. ESO re-syncs (up to an hour later) — the Kubernetes Secret updates; the pod
   *still* has the old key, because env vars are read at process start.
3. The pod restarts — only now is the new key live.

A button that writes a version and reports success is lying about a three-step
operation. **Decision: the portal performs all three steps and verifies the
third.**

## Current state (verified 2026-08-05)

- Secrets: `prod-kora-gemini-api-key`, `prod-kora-openai-api-key`.
- `prod-kora-gemini-api-key` has **exactly one enabled version, created
  2026-07-29**. Neither key has ever been rotated.
- `kora-api-secrets` maps them to `gemini_api_key` / `openai_api_key`;
  `refreshInterval: 1h`.
- The portal's KSA `company` (ns `tesserix`) is bound to GSA
  `app-secrets-marketplace-prod@tesseracthub-480811`, which **already holds
  project-level `roles/secretmanager.admin` and `roles/secretmanager.secretAccessor`**.
  So writing versions needs **no new GCP IAM**.
- Phase 1 already ships `lib/secrets/key-health.ts`, which reads version
  metadata and deliberately **never calls `accessSecretVersion`**.

## Rotate

**Decision: paste the new key into the portal.**

This knowingly breaks the read-only module's "no secret value ever enters the
portal" boundary. It was chosen for usability over a flow where the operator
runs `gcloud secrets versions add` by hand. The boundary is therefore replaced
by explicit handling rules rather than by absence:

- Masked input; never echoed back in any response.
- Never logged — not at any level, not in an error path, not in a request dump.
- Never persisted anywhere but Secret Manager.
- The audit row records **the new version id, never the value**.

`lib/secrets/key-health.ts` keeps its no-`accessSecretVersion` property and its
test. Rotation lives in a separate module so that boundary stays intact for
reads.

### Sequence

1. Operator pastes the key.
2. `addSecretVersion` on the target secret.
3. Force the ExternalSecret to re-sync rather than waiting out the 1h interval.
4. Restart `deploy/kora-api`.
5. **Poll until a Ready pod exists whose creation timestamp is after the sync.**
   Only then report success.
6. Write the audit row.

Step 5 is the difference between this and a UI that reports success while the
old key is still serving traffic. Report the running state, not the command's
exit.

### `written_not_live` is a real state

If the version lands and the restart fails, the page says exactly that — which
secret, which version, and that the pod is still on the previous key. Silently
showing success here is how someone spends an hour debugging a key that was
never loaded.

## Rollback

**Included deliberately, though not requested.**

A bad key breaks every AI path in prod simultaneously — photo, text, voice and
coach all resolve through the same two providers. Secret Manager retains old
versions, so "roll back to the previous version" is nearly free to build and is
the difference between a five-minute mistake and an outage.

It runs the same sequence from step 3, targeting the prior enabled version. It
is a first-class button on the page, not a runbook step.

## No key format validation

**Decision: do not validate the shape of a pasted key.**

Rejecting a "malformed" key risks refusing a valid one when a provider changes
its prefix — and that failure mode is worse than accepting a bad key, which
rollback already covers. An empty value is refused; nothing else is judged.

## New privilege

The portal's KSA needs Kubernetes RBAC in the **`kora` namespace** to:

- patch `deployments` (the rollout restart), and
- patch `externalsecrets` (the forced re-sync).

This is a genuine privilege increase and the only new permission this design
needs. It is namespace-scoped to `kora`; it must not be granted cluster-wide.

## Pages

`app/admin/apps/kora/keys`:

- One row per key: name, current version id, age in days, the env var it maps
  to, the ExternalSecret's last sync time, and whether the running pod is on the
  current version.
- Rotate (masked input, confirmation) and Roll back, per key.
- Rotation history from Secret Manager version metadata, joined with the audit
  rows for who did it.

Phase 1's two Overview tiles (`ai_keys_configured`, `ai_key_age_days`) stay as
they are and link here.

## Out of scope

- **A post-rotation smoke check** — having kora-api make one real provider call
  to prove the new key works. Genuinely valuable, and it would catch a typo
  immediately rather than on the next user's capture, but it needs a new
  kora-api endpoint, which pulls this subsystem into kora-api scope. Worth
  revisiting once the food-data BFF exists, since the authenticated path will
  already be there.
- **Other products' keys.** The mechanism generalises, but mark8ly and homechef
  are not in scope here.
- **Automatic rotation on a schedule.** Nothing in Kora needs it, and it would
  need the smoke check above to be safe.
