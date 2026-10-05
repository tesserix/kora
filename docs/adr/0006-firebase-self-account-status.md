# Firebase self-account status verification

## Context

The production workload cannot administratively read users in the separate Firebase project. Both available operator accounts also lack authority to grant that access. Authentication must still reject revoked, disabled and deleted sessions. Assets are user diaries, uploads and AI quota; hostile clients must not cross the authenticated-user boundary with forged or stale sessions.

## Decision

With FIREBASE_API_KEY configured, first verify signature, issuer, audience and expiry using the Firebase SDK. Only then send the token to Firebase accounts:lookup using the existing project client API key. Require exactly one matching localId, disabled=false, a nonnegative validSince, and positive auth_time at least validSince. Missing or malformed status fails closed. Never use token issue time as the revocation boundary.

The API key comes from a namespace-scoped OpenBao ExternalSecret. No key or token is logged. Reject redirects and cap response bodies at 1 MiB. The outbound lookup has a 5 second deadline within the existing 10 second verifier deadline. There are no retries or caches, so every authenticated request observes current account state. Firebase unavailability denies authentication. Without the key, retain the SDK administrative revocation check; lookup failure never falls back to signature-only acceptance.

Official contract: https://firebase.google.com/docs/reference/rest/auth#section-get-account-info

## Alternatives and consequences

Granting firebaseauth.users.get would preserve the previous SDK flow but requires an unavailable Firebase project administrator. Signature-only validation was rejected because it accepts revoked and disabled sessions. This change does not solve administrative identity deletion permissions.

One outbound account lookup per authenticated request replaces one administrative lookup. No datastore or API contract changes are introduced. Peak traffic and p99 baselines are not measured here; capacity claims are therefore deferred. Monitor authentication failures and latency after rollout. Rollback is the previous image/configuration through GitOps, retaining the deployment hold if administrative verification is unavailable. Existing account deletion remains independent.

Unit tests cover revocation, disabled/mismatched users, malformed and oversized responses, cancellation, redirects, signature-first ordering and no fallback. Live disposable-account checks additionally exercise valid, forged, password-revoked and deleted sessions; disabled-user mutation requires administrator access and is not claimed as live-tested.
