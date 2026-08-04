# Kora Postgres Cutover Runbook

**Scope:** This document is followed by a human, with an assistant, in one deliberate
session. It moves `kora_db` from the shared `global-postgres` cluster (namespace
`global`) onto the dedicated `kora-postgres` cluster (namespace `kora`). It is not
automated and nothing in it should be run unattended.

**Design:** `docs/superpowers/specs/2026-08-04-kora-postgres-migration-design.md`
**Verification SQL:** `docs/runbooks/kora-postgres-migration-verify.sql`

**Fixed facts used throughout:**

| Thing | Value |
|---|---|
| Old cluster | `global-postgres`, namespace `global`, pod `global-postgres-1` |
| Old DB / owner | `kora_db` / role `kora` |
| Old role's password | k8s secret `global-postgres-kora` (namespace `global`, keys `username`/`password`) |
| New cluster | `kora-postgres`, namespace `kora` |
| New DB / owner | `kora_db` / role `kora` (same names — only host and password move) |
| New cluster's app secret | `kora-postgres-app` (namespace `kora`, CNPG-generated, keys include `username`/`password`) |
| New cluster's RW service | `kora-postgres-rw.kora.svc.cluster.local:5432` |
| App Deployment | `kora-api`, namespace `kora` |
| App's DB secret | k8s secret `kora-api-secrets` (namespace `kora`), key `database_url` → env `DATABASE_URL` |
| App's ExternalSecret | `kora-api-secrets` (namespace `kora`, `refreshInterval: 1h`) |
| GCP Secret Manager secret | `prod-kora-database-url`, project `tesseracthub-480811` |
| Prod API host | `https://kora-api.tesserix.app` |
| Required extensions | `vector`, `pgcrypto`, `pg_trgm` |

Set up a scratch directory once, at the start of the session, so every command below
can use it:

```bash
mkdir -p ~/kora-cutover && cd ~/kora-cutover
```

---

## 0. Prerequisites (before scheduling this session)

- [ ] The `tesserix-k8s` PR provisioning the `kora-postgres` chart and its ArgoCD
      `Application` is merged to `main`.
- [ ] The `kora-postgres` ArgoCD Application has been synced **and its reported
      revision actually matches git HEAD** — "Synced/Healthy" alone has already been
      mistaken for evidence twice in this project:

  ```bash
  kubectl -n argocd get application kora-postgres -o jsonpath='{.status.sync.revision}{"\n"}'
  git -C /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s rev-parse HEAD
  ```
  Expected: the two hashes are **identical**. If they are not, force a hard refresh
  and re-check before proceeding — do not trust the ArgoCD UI's status pill on its
  own:

  ```bash
  kubectl -n argocd annotate application kora-postgres argocd.argoproj.io/refresh=hard --overwrite
  ```

- [ ] Storage sizing was measured against the live source database and, if
      `pg_database_size('kora_db')` exceeded 5Gi, `storageSize` in
      `charts/apps/kora-postgres/values.yaml` was raised before this PR merged.

---

## 1. Pre-flight

**1a. New cluster is healthy**

```bash
kubectl get cluster kora-postgres -n kora
```
Expected: `STATUS` column reads `Cluster in healthy state`.

**1b. All three extensions exist on the new cluster**

```bash
NEW_USER=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.username}' | base64 -d)
NEW_PASS=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.password}' | base64 -d)

kubectl exec -n kora kora-postgres-1 -- env PGPASSWORD="$NEW_PASS" \
  psql -h localhost -U "$NEW_USER" -d kora_db -tAc "SELECT extname FROM pg_extension ORDER BY extname;"
```
Expected: the output includes `pgcrypto`, `pg_trgm`, `plpgsql`, `vector`. If any of
`vector` / `pgcrypto` / `pg_trgm` is missing, **stop** — the chart's `postInitSQL`
did not run as expected; do not proceed to the dump.

**1c. The Task 3 baseline has been captured from the source**

Run the committed verification SQL against `global-postgres` and save it — this is
what Step 5 diffs against:

```bash
OLD_USER=$(kubectl get secret global-postgres-kora -n global -o jsonpath='{.data.username}' | base64 -d)
OLD_PASS=$(kubectl get secret global-postgres-kora -n global -o jsonpath='{.data.password}' | base64 -d)

kubectl exec -n global global-postgres-1 -- env PGPASSWORD="$OLD_PASS" \
  psql -h localhost -U "$OLD_USER" -q -d kora_db -f - \
  < /Users/Mahesh.Sangawar/personal/tesserix-new/kora/docs/runbooks/kora-postgres-migration-verify.sql \
  > ~/kora-cutover/baseline.txt

cat ~/kora-cutover/baseline.txt
```
Expected: five result sets, no `ERROR:` lines. Read it before continuing — this is
the baseline every later check is compared against. If anything errors, fix it now;
do not carry a broken baseline into the cutover.

---

## 2. Stop writes

Writes must stop **before** the dump, or the restored copy silently misses
everything logged during it.

```bash
# Record the running image so Step 7 can confirm we come back on the same one.
kubectl get pods -n kora -l app.kubernetes.io/name=kora-api \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}{"\n"}' | tee ~/kora-cutover/pre-scale-image.txt

kubectl scale deploy/kora-api -n kora --replicas=0
```

Confirm zero Ready pods before continuing:

```bash
kubectl get pods -n kora -l app.kubernetes.io/name=kora-api
```
Expected: no pods listed (or all `Terminating`, then none). Do not proceed to the
dump while any `kora-api` pod is still Running.

---

## 3. Dump

```bash
OLD_USER=$(kubectl get secret global-postgres-kora -n global -o jsonpath='{.data.username}' | base64 -d)
OLD_PASS=$(kubectl get secret global-postgres-kora -n global -o jsonpath='{.data.password}' | base64 -d)
DUMP_FILE=~/kora-cutover/kora_db_$(date +%Y%m%d%H%M%S).dump

kubectl exec -n global global-postgres-1 -- env PGPASSWORD="$OLD_PASS" \
  pg_dump -h localhost -U "$OLD_USER" -d kora_db --no-owner --no-acl -Fc \
  > "$DUMP_FILE"

echo "$DUMP_FILE" > ~/kora-cutover/dump-file-path.txt
ls -la "$DUMP_FILE"
```
Record the byte size printed by `ls -la`. A dump of a few KB (rather than however
large `food_items` + its embeddings actually are) means the dump is empty or
truncated — **stop and investigate before restoring it.**

---

## 4. Restore

```bash
DUMP_FILE=$(cat ~/kora-cutover/dump-file-path.txt)
NEW_USER=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.username}' | base64 -d)
NEW_PASS=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.password}' | base64 -d)

kubectl exec -i -n kora kora-postgres-1 -- env PGPASSWORD="$NEW_PASS" \
  pg_restore -h localhost -U "$NEW_USER" -d kora_db --no-owner --no-acl --clean --if-exists \
  < "$DUMP_FILE"
```
`pg_restore` prints warnings for objects that don't exist yet on a first restore
(from `--clean --if-exists` trying to drop things that were never there) — those are
expected and not a failure signal. A **non-zero exit status**, or an `ERROR:` line
that is not a `DROP ... does not exist, skipping` notice, is a failure signal:

```bash
echo "exit code: $?"
```
Expected: `0`. Stop and investigate on anything else.

---

## 5. Verify — before touching the secret

Run the same Task 3 SQL against the restored database and diff it against the
baseline captured in Step 1c:

```bash
NEW_USER=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.username}' | base64 -d)
NEW_PASS=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.password}' | base64 -d)

kubectl exec -n kora kora-postgres-1 -- env PGPASSWORD="$NEW_PASS" \
  psql -h localhost -U "$NEW_USER" -q -d kora_db -f - \
  < /Users/Mahesh.Sangawar/personal/tesserix-new/kora/docs/runbooks/kora-postgres-migration-verify.sql \
  > ~/kora-cutover/postrestore.txt

diff -u ~/kora-cutover/baseline.txt ~/kora-cutover/postrestore.txt \
  && echo "VERIFY: MATCH — safe to proceed to Step 6" \
  || echo "VERIFY: MISMATCH — DO NOT PROCEED, see abort conditions below"
```

> **Note on query 1 (`n_live_tup`):** this is a live-tracked estimate, not a fresh
> `COUNT(*)`. It is normally accurate immediately after `pg_restore` because the
> stats collector updates it as rows are inserted, but if it looks off by a small
> amount, wait ~10 seconds and re-run the diff once before treating it as real —
> then judge it by the abort conditions below, not by eyeballing it.

### STOP — do not proceed past this point if any of the following is true

- **Any row-count mismatch** for any table in query 1's output (after the
  10-second re-check above).
- **Any difference in the `embedded` count** in query 2's output. This is the
  single most important check: a partially restored index is the documented way
  every capture fails while the service still looks healthy.
- **A missing HNSW index** in query 3's output. A restore that silently drops it
  leaves resolution *slow*, not broken — the hardest regression to notice, so do
  not skip this check because query 1 and 2 passed.
- **A missing extension** in query 4's output — any of `vector`, `pgcrypto`,
  `pg_trgm` absent.
- **A different `schema_migrations` row** in query 5's output — the source and
  target are on different schema versions.

If any of these is true: do **not** run Step 6. Go to [Rollback](#rollback) —
the old database is untouched, so there is nothing to undo yet; just scale
`kora-api` back up against the unchanged secret:

```bash
kubectl scale deploy/kora-api -n kora --replicas=1
```
Then investigate the restore before attempting the cutover again.

---

## 6. Swap the secret

**This is the step this project has gotten wrong twice before.** Updating the value
in GCP Secret Manager does **not** change the materialised Kubernetes Secret until
External Secrets Operator refreshes it — and the configured `refreshInterval` is
**one hour**. "Synced/Healthy" on the ExternalSecret and "the annotation was applied"
have both already been mistaken for evidence that the value changed. The only
acceptable evidence is reading the decoded value back out of the Kubernetes Secret
and comparing it to what you wrote.

**6a. Build the new connection string**, in the format this fleet's CNPG clusters
require (`docs/cnpg-migration-guide.md` §7 — TLS is enforced, clients must use
`sslmode=require`):

```bash
NEW_USER=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.username}' | base64 -d)
NEW_PASS=$(kubectl get secret kora-postgres-app -n kora -o jsonpath='{.data.password}' | base64 -d)
NEW_DATABASE_URL="postgresql://${NEW_USER}:${NEW_PASS}@kora-postgres-rw.kora.svc.cluster.local:5432/kora_db?sslmode=require"
echo "$NEW_DATABASE_URL" > ~/kora-cutover/new-database-url.txt
```

**6b. Record the currently-active secret version, for rollback**

```bash
OLD_VERSION=$(gcloud secrets versions list prod-kora-database-url \
  --project=tesseracthub-480811 --filter="state=ENABLED" \
  --sort-by="~createTime" --limit=1 --format="value(name)")
echo "$OLD_VERSION" | tee ~/kora-cutover/pre-swap-secret-version.txt
```
Keep this file — [Rollback](#rollback) uses it.

**6c. Write the new version to GCP Secret Manager**

```bash
printf '%s' "$NEW_DATABASE_URL" | gcloud secrets versions add prod-kora-database-url \
  --project=tesseracthub-480811 --data-file=-
```

**6d. Force External Secrets to refresh now, instead of waiting up to an hour**

```bash
kubectl annotate externalsecret kora-api-secrets -n kora \
  force-sync="$(date +%s)" --overwrite
```

**6e. Verify the materialised Kubernetes Secret's value actually changed — not
just that the ExternalSecret reports Synced**

```bash
for i in $(seq 1 12); do
  CURRENT=$(kubectl get secret kora-api-secrets -n kora -o jsonpath='{.data.database_url}' | base64 -d)
  if [ "$CURRENT" = "$NEW_DATABASE_URL" ]; then
    echo "SECRET SWAP CONFIRMED: materialised value matches the new connection string."
    break
  fi
  echo "waiting for the materialised secret to update (attempt $i/12)..."
  sleep 5
done

CURRENT=$(kubectl get secret kora-api-secrets -n kora -o jsonpath='{.data.database_url}' | base64 -d)
[ "$CURRENT" = "$NEW_DATABASE_URL" ] && echo "PASS: materialised secret == new value" \
  || echo "FAIL: materialised secret still does NOT match — DO NOT scale up kora-api"
```

Do **not** proceed to Step 7 until this prints `PASS`. If it still fails after the
loop, check `kubectl describe externalsecret kora-api-secrets -n kora` for the
actual sync error — do not re-run the annotation blindly.

---

## 7. Scale up

Only after Step 6e printed `PASS`:

```bash
kubectl scale deploy/kora-api -n kora --replicas=1
kubectl rollout status deployment/kora-api -n kora --timeout=120s
```

Confirm the pod is Ready **and** compare its image to the one recorded in Step 2 —
this confirms we came back up on the expected build, not something else that
happened to be pulled during the window:

```bash
kubectl get pods -n kora -l app.kubernetes.io/name=kora-api
kubectl get pods -n kora -l app.kubernetes.io/name=kora-api \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}{"\n"}'
diff ~/kora-cutover/pre-scale-image.txt <(kubectl get pods -n kora -l app.kubernetes.io/name=kora-api \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}{"\n"}') \
  && echo "PASS: same image as before the cutover" \
  || echo "NOTE: image changed — confirm this was expected (e.g. a deploy landed during the window)"
```

---

## 8. Verify the running service

`/health` returning 200 proves the process started. It proves nothing about the
data — the only check that exercises the food index, pgvector, and the nutrition
join together is a real resolve.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://kora-api.tesserix.app/health
```
Expected: `200`.

```bash
# <FIREBASE_ID_TOKEN> — a real ID token for a real prod user. Genuinely
# unknowable ahead of time; obtain it from a logged-in mobile session or the
# Firebase console for the kora-app-e6d38 project.
curl -s -X POST https://kora-api.tesserix.app/v1/resolve/text \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"phrase":"one apple"}' | head -c 2000
```
Expected: a JSON body with real candidate(s), not an empty list and not a 5xx. An
empty candidate list here — even with `/health` green — means the food index came
through the restore in a state resolution can't use; treat it as a failed cutover
and go to [Rollback](#rollback).

---

## Rollback

Valid for **7 days**, precisely because nothing in this procedure writes to or
drops `kora_db` on `global-postgres` — it is left completely untouched.

```bash
OLD_VERSION=$(cat ~/kora-cutover/pre-swap-secret-version.txt)

# Secret Manager versions are immutable; "rolling back" means re-adding the old
# payload as a new version, since `latest` always points at the newest version.
gcloud secrets versions access "$OLD_VERSION" --secret=prod-kora-database-url \
  --project=tesseracthub-480811 > ~/kora-cutover/rollback-database-url.txt

gcloud secrets versions add prod-kora-database-url \
  --project=tesseracthub-480811 --data-file=~/kora-cutover/rollback-database-url.txt

kubectl annotate externalsecret kora-api-secrets -n kora \
  force-sync="$(date +%s)" --overwrite

# Same gate as Step 6e — verify the materialised value, don't trust Synced/Healthy.
OLD_DATABASE_URL=$(cat ~/kora-cutover/rollback-database-url.txt)
for i in $(seq 1 12); do
  CURRENT=$(kubectl get secret kora-api-secrets -n kora -o jsonpath='{.data.database_url}' | base64 -d)
  if [ "$CURRENT" = "$OLD_DATABASE_URL" ]; then
    echo "ROLLBACK CONFIRMED: materialised value matches global-postgres again."
    break
  fi
  echo "waiting for the materialised secret to roll back (attempt $i/12)..."
  sleep 5
done

kubectl scale deploy/kora-api -n kora --replicas=1
kubectl rollout status deployment/kora-api -n kora --timeout=120s
curl -s -o /dev/null -w "%{http_code}\n" https://kora-api.tesserix.app/health
```
Expected: `200`, served once again by `global-postgres`.

---

## Follow-up

**Not part of this session. Do not run this until the new cluster has run 7 days of
real production use, and only as a separately-reviewed change:**

```bash
# DO NOT RUN AS PART OF THE CUTOVER.
# kubectl exec -n global global-postgres-1 -- env PGPASSWORD="$OLD_PASS" \
#   psql -h localhost -U "$OLD_USER" -d postgres -c "DROP DATABASE kora_db;"
```

Bundling this drop into the cutover would trade away the cheap rollback at exactly
the moment it is most likely to be needed. Once it is run, review whether the
`global-postgres-kora` ExternalSecret, the `kora` role's `managedRoles` entry, and
the `postInitSQL` line that created `kora_db` in `charts/apps/global-postgres/values.yaml`
should also be removed — that is a separate `tesserix-k8s` change, not this one.

After the 7-day mark, this migration also unblocks the tesserix-home `ProductConfig`
entry and dashboard for Kora (out of scope here — see the design doc's "Out of
scope" section).
