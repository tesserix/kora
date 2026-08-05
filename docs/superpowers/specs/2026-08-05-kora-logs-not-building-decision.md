# Decision — Kora application logs are not surfaced in the admin portal

Date: 2026-08-05. **Decision: not building this.** Recorded rather than deleted,
because the reasoning corrects a factual error in an earlier design and a future
session would otherwise rebuild on it.

## What was proposed

`2026-08-05-kora-admin-surface-design.md` scoped Phase 2 as *"deep links into
Cloud Logging, pre-filtered"*, on this stated premise:

> "GKE already ships container logs there, the API logs structured JSON, and a
> link costs almost nothing to build."

## The premise is false

Verified 2026-08-05 against the live cluster:

```
$ gcloud container clusters describe tesseract-prod-in-gke \
    --region asia-south1 --format="yaml(loggingConfig)"
loggingConfig:
  componentConfig: {}
```

**GKE logging is entirely disabled** — no `SYSTEM_COMPONENTS`, no `WORKLOADS`.
A `gcloud logging read 'resource.type="k8s_container"'` over the project returns
nothing at any age: Cloud Logging has never ingested a container log line from
this cluster.

So Phase 2 as scoped would have produced deep links into an empty dataset. The
link *is* nearly free to build, exactly as the earlier design said — it just
would not have led anywhere.

This is the same shape as the Managed Prometheus finding recorded in
`gmp-not-enabled-podmonitoring-inert`: both observability pipelines are off at
the cluster level, presumably for cost, while the resources that depend on them
look healthy. A `PodMonitoring` reports `Synced` and is never scraped; a
structured-JSON logger writes perfectly good lines that go nowhere but the pod's
own stdout.

## Why we are not enabling it

**User decision, 2026-08-05: "we dont need to get application logs".**

Enabling GKE logging bills per GiB ingested, across every workload on a shared
multi-product cluster — not just Kora. That is a real recurring cost for a
capability that is currently served adequately by:

```
kubectl -n kora logs deploy/kora-api --tail=100
```

which works today and returns the structured JSON the API already emits.

## What replaces it: audit events

**User decision, 2026-08-05: "just the audit event if we have any".**

We have none. Verified: `kora_db` contains **no audit table**. The only
`*_events` table is `ai_usage_events`, which is AI-call metering — provider,
model, tokens, latency, cost, outcome — not an audit trail.

`kora_admin_events` is introduced by
`2026-08-05-kora-food-data-admin-design.md`, written inside the same
transaction as each admin mutation, and surfaced at
`/admin/apps/kora/audit`. That page is the answer to this request, and it
arrives with slice 2 of the food-data work.

**Set expectations correctly about what it will and will not contain.** It
records **admin** actions — who edited a food's macros, who soft-deleted an
item, who triggered an embedding job, who uploaded a CSV. It does **not**
record user or system activity: sign-ins, meal logs, resolve calls and coach
turns are not audit events and will not appear there.

If user-facing activity history is wanted later, that is a separate design and
a separate table. It should not be bolted onto `kora_admin_events`, whose value
comes from being a small, high-trust record of privileged actions.

## What this means for the other designs

- The **failed-capture explorer**
  (`2026-08-05-kora-failed-capture-explorer-design.md`) becomes more important,
  not less. It was already the higher-value surface, and with no log backend it
  is now the *only* in-portal view of AI failures. Its known limitation stands:
  `ai_usage_events` has no `error_message` or `request_id` column, so it can
  show that a call failed but not why. That limitation was previously softened
  by "you can go read the logs" — that mitigation does not exist.
- Nothing else depends on this.

## If this is revisited

The decision to reverse is `--logging=SYSTEM,WORKLOAD` on the cluster, which is
cluster-wide and affects every product. Price it against the shared cluster's
total log volume, not Kora's. Only then are pre-filtered deep links worth
building, and at that point they genuinely are almost free:
`resource.labels.namespace_name="kora"` plus
`resource.labels.container_name="kora-api"` (verified: that is the container's
real name), and a second filter adding `severity>=ERROR`.
