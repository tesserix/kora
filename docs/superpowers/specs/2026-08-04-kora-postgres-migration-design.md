# Design — migrate `kora_db` to a dedicated `kora-postgres` cluster

Date: 2026-08-04. Touches two repos: `kora` (docs, verification queries) and
`tesserix-k8s` (the chart, the ExternalSecret, the cutover).

## Why

Kora is the only product in the fleet without its own database cluster. Every
other one has a dedicated CloudNativePG cluster — `mark8ly-postgres`,
`homechef-postgres`, `devai-postgres`, `stockpilot-postgres`,
`dwellm8-postgres`, `infra-postgres`, `postiz-postgres`,
`agentregistry-postgres` — while `kora_db` lives on the shared
`global-postgres` in namespace `global`. Three concrete consequences:

1. **A tesserix-home dashboard for Kora would report a wrong number.** Its
   `ProductConfig` drives the DB size / replication-lag / connections panels
   from `cnpg_pg_*{cluster=<cnpgClusterName>}`. Pointing Kora at
   `global-postgres` makes those panels show the shared cluster's figures
   labelled as Kora's.
2. **It corrupts the COGS number.** OpenCost attributes cost by namespace.
   Kora's database cost sits in `global`, so Kora's true cost of goods — the
   number #43 exists to produce and #41 gates pricing on — excludes its own
   database.
3. **Blast radius.** pgvector similarity search over `food_items` is not a
   cheap query, and today a runaway one shares an instance with four other
   products.

This is deliberately sequenced **before** the tesserix-home wiring and **after**
the metrics exporter (#43, merged as `871f5df`). The exporter is namespace-keyed
and therefore correct either way; only the DB panels depend on this.

## The new cluster

A new chart at `charts/apps/kora-postgres/`, copied from
`charts/apps/stockpilot-postgres/` — the closest analogue in the fleet: a single
Go service with a pgvector workload, and already the proof that
`CREATE EXTENSION vector` works via `postInitSQL` on the stock image.

| Setting | Value | Why |
|---|---|---|
| namespace | `kora` | namespace-keyed OpenCost attribution is half the point |
| clusterName | `kora-postgres` | matches the `<product>-postgres` convention |
| instances | `1` | matches devai / mark8ly / global; budget constraint |
| imageName | `ghcr.io/cloudnative-pg/postgresql:16.4` | **the same tag `global-postgres` runs today** |
| bootstrap.database | `kora_db` | unchanged, so only host and password move |
| bootstrap.owner | `kora` | unchanged |

**The image tag is load-bearing.** Kora's migrations require three extensions —
`vector` (000004, the `vector(768)` column and its HNSW index), `pgcrypto`
(000001) and `pg_trgm` (000021). Pinning the identical tag that
`global-postgres` runs is what *guarantees* they are available, because
pgvector demonstrably works on that exact image in production right now. This
is inference from a running system, not from documentation. Do not "upgrade"
the tag as part of this migration; that turns a data move into an untested
Postgres upgrade at the same time.

```yaml
bootstrap:
  database: kora_db
  owner: kora
  postInitSQL:
    - "CREATE EXTENSION IF NOT EXISTS vector"
    - "CREATE EXTENSION IF NOT EXISTS pgcrypto"
    - "CREATE EXTENSION IF NOT EXISTS pg_trgm"
```

### Storage sizing

Provision **4× the measured `pg_database_size('kora_db')`, with a 10Gi floor**,
plus WAL at 25% of the data volume. Pending that measurement the chart starts at
`storageSize: 20Gi` / `walStorageSize: 5Gi`, which is comfortably above any
plausible current size — `global-postgres` serves five products from 20Gi total.
Growth is dominated by `food_items.embedding` (768-dimensional vectors) and its
HNSW index, not by user rows, so the food index size is what to watch.

The measurement (the classifier blocks `kubectl exec` for the assistant, so a
human runs it):

```sql
SELECT pg_size_pretty(pg_database_size('kora_db'))          AS db_size,
       (SELECT count(*) FROM food_items)                    AS food_items,
       (SELECT count(*) FROM food_items WHERE embedding IS NOT NULL) AS embedded,
       (SELECT count(*) FROM food_logs)                     AS food_logs,
       (SELECT count(*) FROM users)                         AS users;
```

Keep the output: it is also the baseline the post-restore verification compares
against.

## Cutover — short planned downtime

Chosen over logical replication because Kora is pre-beta on the friends-and-family
milestone, every step is independently verifiable, and rollback is a single
secret swap. Logical replication would additionally require `wal_level=logical`
on `global-postgres`, whose restart would affect four other products, for a
benefit Kora does not need.

1. Provision `kora-postgres` and confirm the three extensions exist.
2. Put the new password in GCP Secret Manager; add the ExternalSecret so the
   `kora` namespace can materialise a `database_url` for the new host.
3. `kubectl scale deploy/kora-api --replicas=0` — writes must stop before the
   dump, or the restored copy silently misses everything logged during it.
4. `pg_dump` `kora_db` from `global-postgres`.
5. Restore into `kora-postgres`.
6. **Verify (below). Do not proceed on a failed check.**
7. Swap `database_url` to the new host; scale `kora-api` back up.
8. Verify again against the running service.

Expected downtime is minutes, dominated by the dump/restore of the food index.

### The seed-job hazard

The `kora-api` chart ships a **seed job at sync-wave 0**. If ArgoCD runs it
against the fresh cluster around the restore, the food index could be both
seeded and restored, duplicating rows — which would corrupt resolution scoring
rather than fail loudly.

The implementation plan must **establish whether `cmd/seed` is idempotent**
(read it; do not assume) and, if it is not, prevent it from running during the
window. This is a known-unknown deliberately surfaced here rather than
discovered mid-cutover.

## Verification

`/health` returning 200 proves the API process started. It proves nothing about
the data. This project has repeatedly mistaken a green signal for a working
system, so the gate is explicit:

**Before the secret swap**

- Per-table row counts match the source for every table, not a sample.
- `food_items` count matches **and** the `embedding IS NOT NULL` count matches.
  A partially restored index is the documented way every capture fails while
  the service looks healthy.
- The HNSW index on `food_items.embedding` exists. A restore that silently drops
  it leaves resolution *slow*, not broken — the hardest kind of regression to
  notice.
- `\dx` lists `vector`, `pgcrypto`, `pg_trgm`.

**After the secret swap**

- The pod is Ready on the expected image digest.
- `/health` returns 200.
- **A real resolve against prod returns real candidates** — a text resolve is
  enough and costs one cheap model call. This is the only check that exercises
  the food index, pgvector and the nutrition join together.

## Rollback

For 7 days, rollback is: point `database_url` back at `global-postgres` and
scale up. The old `kora_db` is left completely untouched by this migration —
nothing in the cutover writes to or drops it.

After 7 days of real use on the new cluster, `DROP DATABASE kora_db` on
`global-postgres` as a **separate, separately-reviewed change**. Bundling the
drop into the migration would trade away the cheap rollback at exactly the
moment it is most likely to be needed.

## Out of scope

- **Upgrading the Postgres version.** Same tag as today, deliberately.
- **A connection pooler, scheduled backups, autoheal and PrometheusRule.**
  `stockpilot-postgres` ships all four. They are worth having, but each is an
  independent change that can land after the data has moved; adding them to the
  cutover widens the blast radius of the one step that has downtime.
- **The tesserix-home `ProductConfig` entry and its dashboard.** That is the
  work this migration unblocks, not part of it.
