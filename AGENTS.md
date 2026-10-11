# Kora development guide

## Scope and architecture

- Treat `api/` as a Go 1.26 Gin service backed by Postgres/pgvector and Redis-compatible infrastructure.
- Treat `apps/mobile/` as an Expo SDK 57 React Native application. The nested `apps/mobile/AGENTS.md` adds version-specific documentation guidance.
- Load `sketch-findings-kora` before building or restyling mobile UI.
- Reuse existing patterns and dependencies before adding abstractions or packages.

## Working method

- Follow `engineering-standards` for every code change and the applicable `go-services`, `expo-mobile`, `postgres-data`, `security-engineering`, `distributed-systems`, or `cloud-engineering` skill.
- For a bug, add and run a regression test that fails for the reported reason before implementing the fix.
- Inspect the affected package first and keep changes limited to the requested behavior.
- Never put secrets, real tokens, production data, or kubeconfig contents in source, tests, logs, screenshots, or chat output.

## Verification

- For API changes, run from `api/`: `gofmt -l .`, `go vet ./...`, `go build ./...`, and `go test -race -p 1 ./...`.
- API integration tests require Postgres and `TEST_DATABASE_URL`; use `infra/docker-compose.yml` and run `go run ./cmd/migrate` before the suite when the database is needed.
- For mobile changes, run from `apps/mobile/`: `npx expo customize tsconfig.json`, `npx tsc --noEmit`, `npm test`, and `npm run lint`.
- Run the smallest relevant test during iteration, then the full affected suite before reporting completion.
- Report every check as passed, failed, or skipped with the reason; do not claim completion from code inspection alone.

## Security review rules

- Scope every user-owned or tenant-owned object lookup by the authenticated principal in the query; cross-user access must return 404 and have a regression test.
- Derive identity, role, ownership, and trusted prices server-side. Validate input at every external boundary and use parameterized queries.
- Keep tokens and credentials out of AsyncStorage and logs; use secure device storage and server-side secret management.
- Review authentication, account deletion, AI capture, file/media ingestion, and admin changes for authorization, rate limits, data retention, and redaction.
- Do not weaken CI permissions, disable tests, suppress scanners, or unpin dependencies merely to make a check pass.
- For security-sensitive, dependency, CI, or release changes, run the relevant installed checks: `govulncheck ./...` from `api/`, `npm audit --audit-level=high` from `apps/mobile/`, `gitleaks git --redact`, and `trivy fs --scanners vuln,secret,misconfig .` from the repository root. Report unavailable feeds or tools instead of silently skipping them.

## GCP and GKE

- Before cloud work, verify with `gcloud auth list --filter=status:ACTIVE`, `gcloud config get-value project`, and `kubectl config current-context`.
- The expected personal environment is project `tesseracthub-480811`, region `asia-south1`, cluster context `gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke`, and namespace `kora`. Treat a mismatch as a stop condition for mutations, not something to overwrite silently.
- Use `kubectl get`, `describe`, `logs`, `events`, `auth can-i`, and GCP describe/list commands for diagnosis before proposing a change.
- Kora delivery is GitOps-driven: CI publishes `ghcr.io/tesserix/kora/kora-api`, then advances the `deploy` branch for Kargo. Make desired-state changes in the owning repository and verify reconciliation read-only.
- Never apply, delete, restart, scale, patch, port-forward into sensitive services, rotate a secret, or trigger a production rollout without explicit user authorization for that action.

## Code review rules

- Flag missing regression tests, authorization scope, boundary validation, error-path handling, cancellation/timeouts, race safety, migration compatibility, secret exposure, and mismatches between CI and documented verification.
- Prioritize behavior and security defects over formatting preferences.
