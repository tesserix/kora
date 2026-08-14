# Runbook: Firebase identity deletion (account deletion, #106)

`DELETE /v1/me` deletes the Kora database row **and** the user's Firebase identity. The Firebase
step is deliberately non-fatal (`api/internal/user/deletion.go`), so when it fails the endpoint
still answers 204 and the identity silently outlives the account. Apple requires in-app deletion to
actually remove the account, so a silent failure here is an App Review blocker.

## The two-project split (read this before diagnosing anything)

Kora spans two GCP projects, and conflating them has now caused two separate production bugs:

| Project | What lives there |
|---|---|
| `tesseracthub-480811` | GKE cluster, workloads, service accounts. **No Kora identities.** |
| `kora-app-e6d38` | Kora's own Firebase project. **Every Kora user identity.** |

Prod runs `FIREBASE_PROJECT_ID=kora-app-e6d38`. Kora is a plain Firebase project, **not** one of the
23 GIP tenants in `tesseracthub-480811`.

Prior art: `kora-api` validated tokens against `tesseracthub-480811` until 2026-08-01
(`docs/superpowers/HANDOFF-2026-08-01-auth.md`). On 2026-08-08 the same wrong-project mistake was
repeated for IAM, which is what broke #106.

## Required IAM

`kora-api-prod@tesseracthub-480811.iam.gserviceaccount.com` (bound to KSA `kora/kora-api` via
workload identity) must hold `firebaseauth.users.delete` **in `kora-app-e6d38`**. A grant in
`tesseracthub-480811` alone does nothing for account deletion.

This IAM is managed by hand, not in Terraform. If the project is ever rebuilt, reapply:

```bash
gcloud iam roles create koraFirebaseUserDelete --project=kora-app-e6d38 \
  --title="Kora Firebase user deletion" \
  --permissions=firebaseauth.users.delete --stage=GA

gcloud projects add-iam-policy-binding kora-app-e6d38 \
  --member="serviceAccount:kora-api-prod@tesseracthub-480811.iam.gserviceaccount.com" \
  --role="projects/kora-app-e6d38/roles/koraFirebaseUserDelete" --condition=None
```

Least privilege is deliberate: `roles/firebaseauth.admin` would also grant create/update/list and
config access. IAM changes take effect **without** a pod restart.

## Verifying the permission

**HTTP status does not discriminate.** A granted and an ungranted `accounts:delete` both return
**400**. Read `error.message`:

- `USER_NOT_FOUND` → permission is fine, the uid simply does not exist
- `INSUFFICIENT_PERMISSION` → the grant is missing

Probe with a **nonexistent uid** so the check cannot destroy anything. busybox `wget` in the pod
hides 4xx bodies, so pull the pod's own workload-identity token out and curl locally:

```bash
CTX=gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke
POD=$(kubectl --context $CTX -n kora get pod -l app.kubernetes.io/name=kora-api -o name | head -1)

AT=$(kubectl --context $CTX -n kora exec ${POD#pod/} -c kora-api -- sh -c \
  'wget -qO- --header="Metadata-Flavor: Google" \
   http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/projects/kora-app-e6d38/accounts:delete" \
  -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
  -d '{"localId":"zzz-nonexistent-probe-uid-000"}'
```

## End-to-end check (exercises the real Admin SDK path)

The permission probe uses raw REST; this exercises the code path that actually ships. Uses a
throwaway identity that the flow itself cleans up.

```bash
KEY=$(gcloud services api-keys get-key-string \
  843dd7bc-6af9-4a8f-a866-2c58cbfd8352 --project=kora-app-e6d38 --format="value(keyString)")
EMAIL=kora-issue106-probe@tesserix.dev; PW='Issue106Probe!2026'

# Sign up (or signInWithPassword if it already exists) -> idToken + localId
RESP=$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=$KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"returnSecureToken\":true}")

# GET /v1/me creates the DB row, then DELETE /v1/me must return 204
curl -s -X DELETE https://kora-api.tesserix.app/v1/me -H "Authorization: Bearer <idToken>"

# Then confirm the identity is really gone (accounts:lookup returns no "users" key)
```

In zsh, do not assign to a variable named `UID` — it is readonly and the script will abort.

## Observability caveat

Container logs for this cluster **never reach Cloud Logging** — only `k8s_cluster` entries exist,
no `k8s_container`. The warning `firebase identity survived deletion; NEEDS MANUAL CLEANUP` is
visible only via `kubectl logs` against a live pod and is lost on restart. An empty Cloud Logging
query is **not** evidence that the failure did not happen.

## Cleaning up orphaned identities

Identities stranded by past failures show up as a count mismatch between Firebase and the database:

```bash
# Firebase identities
curl -s -X GET \
  "https://identitytoolkit.googleapis.com/v1/projects/kora-app-e6d38/accounts:batchGet?maxResults=200" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: kora-app-e6d38"

# Database users
kubectl --context $CTX exec -n global global-postgres-1 -c postgres -- \
  psql -q -d kora_db -c "SELECT firebase_uid, email FROM users;"
```

Delete stragglers by uid with `accounts:delete`. Confirm each one is a test account first — a
mismatch is expected while a user is mid-signup.
