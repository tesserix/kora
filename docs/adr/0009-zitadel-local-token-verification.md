# Zitadel access tokens verified locally

Status: accepted. Supersedes ADR-0006, which applied only to Firebase.

## Context

Kora moves from its own Firebase Auth project to the platform's self-hosted Zitadel (`https://auth.tesserix.app`). The plan is `docs/superpowers/plans/2026-10-13-kora-zitadel-migration.md`. ADR-0006 called Firebase's `accounts:lookup` on every request, so a revoked, disabled or deleted account was rejected immediately.

Zitadel issues JWT access tokens for every Kora client, because the onboarding operator hardcodes `OIDC_TOKEN_TYPE_JWT`. Each token names the Kora project in `aud` and the user in `sub`, and carries no email or name.

## Decision

Verify signature, issuer, expiry and the Kora project audience locally against the issuer's cached JWKS. Make no per-request call to Zitadel. The token proves only the subject. Email and name come from userinfo, fetched with the caller's own token only while the user row lacks them, and at most once per ten minutes per user. An unverified email is dropped, because friend requests look users up by email.

Account deletion removes the Zitadel user (`DELETE /v2/users/{id}`) with a machine user's PAT. That PAT is required in production. Deleting the user also removes its Apple and Google links. Revoking the Apple grant itself is a platform concern, tracked in tesserix/tesserix-k8s#1388.

## Consequences

The revocation window is now the access-token lifetime. The instance default in `tesserix-k8s` `charts/thirdparty/zitadel/values.yaml` is one hour. A deactivated or deleted user's token keeps working until it expires. Shortening that window is an instance-wide setting that affects every platform app, so it is a platform decision rather than Kora's.

Per-request token introspection was rejected. It would restore ADR-0006's immediacy, but at the cost of a Zitadel round trip on every request and a Zitadel outage taking Kora down. tesserix-home's platform-auth made the same per-request mistake with userinfo and reverted it (#450, #453).

The API runs OIDC discovery at startup and refuses to boot if discovery fails. CI serves a stub discovery document for the admin conformance run.
