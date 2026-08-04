# Kora Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `kora_db` off the shared `global-postgres` onto a dedicated `kora-postgres` CloudNativePG cluster in the `kora` namespace, with a short planned downtime and a one-secret rollback.

**Architecture:** A new Helm chart `charts/apps/kora-postgres/` in `tesserix-k8s`, copied from `stockpilot-postgres`, pinned to the same Postgres image `global-postgres` runs today. Cutover is `scale to zero → pg_dump → restore → verify → swap the ExternalSecret → scale up`. The old database is left untouched for 7 days so rollback stays free.

**Tech Stack:** CloudNativePG, Helm, ArgoCD, External Secrets Operator + GCP Secret Manager, PostgreSQL 16.4 with pgvector.

**Spec:** `docs/superpowers/specs/2026-08-04-kora-postgres-migration-design.md`

## Global Constraints

- Two repos. Chart work is in `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s`; docs and SQL are in `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`.
- Commits are **single-line conventional commits**. No body, no trailers, no signature.
- Image tag is **exactly** `ghcr.io/cloudnative-pg/postgresql:16.4` — the tag `global-postgres` runs today. Do NOT upgrade Postgres in this change.
- Database name `kora_db` and owner `kora` are **unchanged**.
- **Nothing in Tasks 1–3 applies anything to the live cluster.** Validation is `helm template` and `kubectl apply --dry-run=server` only. The cutover (Task 4) is run by a human, with the assistant, as a deliberate session.
- `tesserix-k8s` CI has been unable to start jobs since 2026-08-03 (no runner assigned, ~2s failures, all workflows including scheduled ones). Do not interpret a red PR there as a defect in this work without first checking whether CI is running at all.
- `charts/**` IS covered by that repo's CI; `manifests/**` is NOT. This work is entirely under `charts/**`.
- Chart changes require a **version bump** in `Chart.yaml` — `ct lint` runs with `check-version-increment: true` and rejects a changed chart at an unchanged version.

## Facts already established (do not re-derive)

- **`cmd/seed` is idempotent.** `nutrition.Repository.Insert` (`api/internal/nutrition/repository.go:72`) skips an item whose barcode, or whose `(name, brand)` pair, already exists. A seed job firing after the restore inserts zero rows. The sync-wave-0 seed job is therefore **not** a duplication hazard.
- **Extensions required:** `vector` (migration 000004), `pgcrypto` (000001), `pg_trgm` (000021).
- **`stockpilot-postgres` already runs `CREATE EXTENSION vector` via `postInitSQL` on the identical image**, which is the evidence that pgvector is available on that tag.
- **The app reads `DATABASE_URL` from GCP Secret Manager key `prod-kora-database-url`**, mapped by `charts/apps/kora-api/values.yaml` (`externalSecret.remoteRefs.database_url`) through an ExternalSecret at sync-wave `-2`. The cutover changes the *value* of that Secret Manager secret; no chart change is needed to switch hosts.
- The same secret feeds the **migrate job** (sync-wave -1) and the **seed job** (sync-wave 0).

---

### Task 1: The `kora-postgres` chart

**Files (all in `tesserix-k8s`):**
- Create: `charts/apps/kora-postgres/Chart.yaml`
- Create: `charts/apps/kora-postgres/values.yaml`
- Create: `charts/apps/kora-postgres/templates/cluster.yaml`
- Reference (read, do not modify): `charts/apps/stockpilot-postgres/`

**Interfaces:**
- Consumes: nothing.
- Produces: a CNPG `Cluster` named `kora-postgres` in namespace `kora`, owning database `kora_db` with owner `kora`, and a CNPG-generated credentials secret consumed in Task 4.

- [ ] **Step 1: Branch**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
git checkout main && git pull --ff-only
git checkout -b feat/kora-postgres-cluster
```

- [ ] **Step 2: Read the template chart before copying it**

Read all of `charts/apps/stockpilot-postgres/values.yaml` and
`charts/apps/stockpilot-postgres/templates/cluster.yaml`. Copy its *structure*.
Do NOT copy its sizing (100Gi/20Gi) or its `postInitSQL` list verbatim — Kora
needs different extensions and far less storage.

- [ ] **Step 3: Write `Chart.yaml`**

```yaml
apiVersion: v2
name: kora-postgres
description: Tesserix Kora — dedicated CloudNativePG cluster (food index, pgvector recall)
type: application
version: 0.1.0
appVersion: "16.4"
maintainers:
  - name: Tesserix
```

- [ ] **Step 4: Write `values.yaml`**

Storage follows the spec's rule: 4× measured `pg_database_size('kora_db')`, floor
10Gi, WAL at 25% of data. Pending that measurement these are the starting values;
if the measurement shows the database is larger than 5Gi, raise `storageSize`
before the PR rather than after.

```yaml
namespace: kora
clusterName: kora-postgres

instances: 1
imageName: ghcr.io/cloudnative-pg/postgresql:16.4

storageSize: 20Gi
storageClass: standard-rwo-retain
walStorageSize: 5Gi

resources:
  requests:
    memory: 512Mi
  limits:
    memory: 2Gi

bootstrap:
  database: kora_db
  owner: kora
  # First-init only. CNPG runs these once, when the cluster is created.
  # vector    — migration 000004: food_items.embedding vector(768) + HNSW index
  # pgcrypto  — migration 000001
  # pg_trgm   — migration 000021: trigram scoring on food names
  postInitSQL:
    - "CREATE EXTENSION IF NOT EXISTS vector"
    - "CREATE EXTENSION IF NOT EXISTS pgcrypto"
    - "CREATE EXTENSION IF NOT EXISTS pg_trgm"

postgresql:
  max_connections: "100"
  shared_buffers: "512MB"
  effective_cache_size: "1536MB"
  work_mem: "16MB"
  maintenance_work_mem: "256MB"
  ssl_min_protocol_version: "TLSv1.3"
  ssl_max_protocol_version: "TLSv1.3"
  idle_in_transaction_session_timeout: "300000"
  statement_timeout: "120000"
  random_page_cost: "1.1"
  effective_io_concurrency: "200"
```

- [ ] **Step 5: Write `templates/cluster.yaml`**

Model it on `charts/apps/stockpilot-postgres/templates/cluster.yaml`. It must
render a `postgresql.cnpg.io/v1` `Cluster` that uses every value above:
`instances`, `imageName`, `storage.size`/`storageClass`, `walStorage.size`,
`resources`, `bootstrap.initdb` with `database`/`owner`/`postInitSQL`, and the
`postgresql.parameters` map. Do not invent fields the template chart does not
use.

- [ ] **Step 6: Render and inspect**

```bash
helm template kora-postgres charts/apps/kora-postgres | head -80
```
Expected: one `Cluster`, `instances: 1`, image tag `16.4`, and all three
`CREATE EXTENSION` lines present in `bootstrap.initdb.postInitSQL`.

- [ ] **Step 7: Validate against the live API server**

```bash
helm template kora-postgres charts/apps/kora-postgres | kubectl apply --dry-run=server -f -
```
Expected: `cluster.postgresql.cnpg.io/kora-postgres created (server dry run)`.
A CRD error here means the apiVersion or a field name is wrong — fix before
committing. **This does not create anything.**

- [ ] **Step 8: Confirm the image tag matches production**

```bash
kubectl get cluster -n global global-postgres -o jsonpath='{.spec.imageName}{"\n"}'
grep imageName charts/apps/kora-postgres/values.yaml
```
Expected: identical strings. This is the check that guarantees the extension set.

- [ ] **Step 9: Commit**

```bash
git add charts/apps/kora-postgres/
git commit -m "feat(kora): dedicated postgres cluster chart"
```

---

### Task 2: ArgoCD wiring

**Files (all in `tesserix-k8s`):**
- Modify: whichever app-of-apps manifest declares the kora Applications — find it, do not guess.

**Interfaces:**
- Consumes: the chart from Task 1.
- Produces: an ArgoCD `Application` named `kora-postgres` that will sync the chart.

- [ ] **Step 1: Find how the sibling clusters are registered**

```bash
grep -rn "stockpilot-postgres" --include="*.yaml" argocd/ k8s/ charts/ | grep -v "charts/apps/stockpilot-postgres/" | head
kubectl -n argocd get application stockpilot-postgres -o yaml | head -40
```
Read both before writing anything. Register `kora-postgres` exactly the way
`stockpilot-postgres` is registered — same generator, same sync options, same
project.

- [ ] **Step 2: Add the Application**

Mirror the sibling entry. It **must not** have automated sync enabled on first
creation — this cluster is provisioned deliberately in Task 4, not by a
background sync while nobody is watching. If the surrounding pattern is an
ApplicationSet with automated sync, note that in the report and stop; that is a
decision for the human, not a silent default.

- [ ] **Step 3: Validate**

```bash
kubectl apply --dry-run=server -f <the modified file>
```
Expected: `configured (server dry run)` with no errors.

- [ ] **Step 4: Bump and commit**

The `kora-api` chart is untouched here, so no bump is needed for it. If this
task modified any chart under `charts/`, bump that chart's `version` in its
`Chart.yaml` — `ct lint` runs `check-version-increment: true`.

```bash
git add -A
git commit -m "feat(kora): register the kora-postgres application"
git push -u origin feat/kora-postgres-cluster
gh pr create --title "feat(kora): dedicated postgres cluster for kora" --body "Provisions a dedicated CloudNativePG cluster for Kora, replacing its use of the shared global-postgres. Chart copied from stockpilot-postgres; image tag pinned to the same 16.4 global-postgres runs today, which is what guarantees pgvector/pgcrypto/pg_trgm are available. Not synced by this PR — the cutover is a separate deliberate step. Design: kora/docs/superpowers/specs/2026-08-04-kora-postgres-migration-design.md"
```

Note: that repo's CI may be unable to run (see Global Constraints). Check
whether jobs are being assigned runners at all before treating red as a defect.

---

### Task 3: Baseline and verification SQL

**Files (in the `kora` repo):**
- Create: `docs/runbooks/kora-postgres-migration-verify.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: one SQL file run against BOTH databases, whose outputs must match.

- [ ] **Step 1: Write the file**

```sql
-- Run against BOTH kora_db on global-postgres (before) and kora_db on
-- kora-postgres (after). Every row of output must be identical.
--
--   kubectl exec -n global global-postgres-1 -- psql -q -d kora_db -f - < this
--   kubectl exec -n kora   kora-postgres-1   -- psql -q -d kora_db -f - < this
--
-- /health returning 200 proves the API started. It proves nothing about the
-- data. These are the checks that do.
SET statement_timeout = '60s';

-- 1. Row counts for every table, not a sample.
SELECT relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY relname;

-- 2. The food index, and how much of it is actually embedded. A partially
--    restored index is the documented way every capture fails while the
--    service looks healthy.
SELECT count(*) AS food_items,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
       count(*) FILTER (WHERE embedding IS NULL)     AS not_embedded
FROM food_items;

-- 3. The HNSW index must exist. A restore that silently drops it leaves
--    resolution SLOW rather than broken — the hardest regression to notice.
SELECT indexname
FROM pg_indexes
WHERE tablename = 'food_items'
ORDER BY indexname;

-- 4. Extensions.
SELECT extname FROM pg_extension ORDER BY extname;

-- 5. Schema version, so a half-applied migration is visible.
SELECT * FROM schema_migrations;
```

- [ ] **Step 2: Sanity-check it parses against the current database**

Ask the human to run it against the source (the assistant is blocked from
`kubectl exec`):

```
! kubectl exec -n global global-postgres-1 -- psql -q -d kora_db -f - < docs/runbooks/kora-postgres-migration-verify.sql
```
Expected: five result sets, no syntax errors. **Keep this output — it is the
baseline the post-restore run is compared against.** If any statement errors,
fix the SQL before the cutover, not during it.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/kora-postgres-migration-verify.sql
git commit -m "docs(kora): verification queries for the postgres migration"
```

---

### Task 4: The cutover runbook

**Files (in the `kora` repo):**
- Create: `docs/runbooks/kora-postgres-cutover.md`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: the document a human follows on cutover day. **This task writes the runbook. It does not perform the cutover.**

- [ ] **Step 1: Write the runbook**

It must contain, in order, with the exact commands:

1. **Pre-flight.** Confirm the new cluster is `Cluster in healthy state`; confirm all three extensions exist; confirm the Task 3 baseline has been captured from the source.
2. **Stop writes.** `kubectl scale deploy/kora-api -n kora --replicas=0`, then confirm zero Ready pods. Writes must stop *before* the dump, or the restored copy silently misses everything logged during it.
3. **Dump.** `pg_dump` of `kora_db` from `global-postgres`, to a file, with its byte size recorded.
4. **Restore** into `kora-postgres`.
5. **Verify** — run the Task 3 SQL against the new cluster and diff against the baseline. **Abort conditions, stated explicitly: any row-count mismatch, any difference in `embedded`, a missing HNSW index, or a missing extension.**
6. **Swap the secret.** Update the GCP Secret Manager secret `prod-kora-database-url` to the new host and password, then force the ExternalSecret to refresh and confirm the materialised Kubernetes secret actually changed — an ESO secret with a 1h `refreshInterval` will otherwise serve the old value.
7. **Scale up.** Confirm a Ready pod on the expected image digest.
8. **Verify the running service.** `/health` 200, **and** a real text resolve returning real candidates. Only the second exercises the food index, pgvector and the nutrition join together.
9. **Rollback**, as its own section: point `prod-kora-database-url` back, refresh, scale up. Valid for 7 days because nothing in this procedure writes to or drops the old database.
10. **Follow-up**, as its own section: after 7 days of real use, `DROP DATABASE kora_db` on `global-postgres` as a separately-reviewed change.

- [ ] **Step 2: Check the runbook against the constraint that matters**

Re-read step 6. If the runbook does not explicitly verify that the Kubernetes
secret's value changed — not merely that the ExternalSecret was annotated — fix
it. "Synced/Healthy" and "annotated" have both already misled this project;
the check must be on the materialised value.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/kora-postgres-cutover.md
git commit -m "docs(kora): cutover runbook for the postgres migration"
```

---

## After all tasks

1. Get the sizing/baseline measurement run and, if `pg_database_size` exceeds 5Gi, raise `storageSize` before the chart PR merges.
2. Merge the `tesserix-k8s` PR, then sync **only** `kora-postgres` — and verify ArgoCD's `.status.sync.revision` equals git HEAD before believing "Synced/Healthy". Force with `kubectl -n argocd annotate application kora-postgres argocd.argoproj.io/refresh=hard --overwrite` if it lags; it has lagged twice in this project.
3. Schedule the cutover as a deliberate session with the human present.
4. Only after the new cluster has run for 7 days: the `DROP DATABASE` follow-up, and the tesserix-home `ProductConfig` entry this migration unblocks.
