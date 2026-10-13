# Kora: Firebase Auth → self-hosted Zitadel

**Status:** draft plan · 2026-10-13
**Prior art:** HomeChef (`cf2f36ed`, `3aa11883`), Helivanta (`docs/adr/0006-zitadel-not-gip.md`), mark8ly (`docs/auth/2026-09-07-gip-removal-audit.md`), and `tesserix-k8s/docs/zitadel-onboarding.md`.

## Where we are

- Kora uses a standalone Firebase Auth project, `kora-app-e6d38`. It is not a GIP tenant.
- The ~18 existing identities are all internal testers. **They are not migrated.** Testers re-register on Zitadel.
- The API verifies tokens with the Firebase Admin SDK (`api/internal/auth/verifier.go`). It also runs a per-request `accounts:lookup` revocation check (`account_status.go`, ADR 0006).
- Users are keyed by `users.firebase_uid`.
- Coupling outside this repo:
  - the Istio `RequestAuthentication` entry `-kora`
  - the AgentGateway JWT policy on the forwarded `X-Kora-End-User-Token`
  - the hand-managed IAM role for identity deletion (`docs/runbooks/kora-firebase-identity-deletion.md`)
- Mobile uses the Firebase JS SDK, imported in about 12 files. Apple and Google sign-in are native.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Clean start: no user import.** Wipe the existing tester accounts through the existing deletion service before cutover. | Testers can re-register. This removes UID mapping, IdP pre-linking, the Apple relay-email split and the password-hash problem. Running the real deletion path also revokes stored Apple refresh tokens and removes the Firebase identities. |
| D2 | **Atomic cutover, no dual-accept** (HomeChef/Helivanta). The API accepts Zitadel tokens only. | There are no external users to drain. "Two providers at once is the worst state." Testers on old builds get a 401 and are told to update. |
| D3 | **Hosted login + PKCE** (HomeChef `packages/mobile-shared/src/auth/zitadel.ts`). Uses `expo-web-browser` `openAuthSessionAsync`, `offline_access`, and a refresh token in SecureStore. | Simplest proven mobile template on the platform. It needs no custom login BFF and no instance PAT. |
| D4 | **Apple and Google via the TESSERIX org IdPs** on the hosted page. Remove native `expo-apple-authentication` and `google-signin` for sign-in. | Nobody has done a native-token → Zitadel exchange. Guideline 4.8 is satisfied by offering Apple. Account linking moves to Zitadel (`AUTO_LINKING_OPTION_EMAIL`), so `LinkAccountPrompt` goes away. |
| D5 | **Rename `users.firebase_uid` → `users.idp_subject` now.** | The table is empty after D1, so the rename is cheap and leaves no Firebase naming behind. |
| D6 | **Add a min-build gate** (`GET /v1/app-config` → `min_build`) in the same release. | Optional, but cheap. It means the next auth change won't strand old builds. |
| D7 | **Pure Zitadel: no native Apple path and no Kora-side Apple tokens.** Remove `internal/appleid`, `POST /v1/me/apple-authorization`, `users.apple_refresh_token` and the `APPLE_*` config. Apple revocation becomes a platform concern, solved once in Zitadel or the identity layer for every product (Q4). | Kora can no longer obtain an Apple code once Zitadel brokers Apple. Keeping a native capture path means a second Apple prompt and a provider-specific side channel, which is exactly the coupling we're removing. HomeChef and mark8ly have the same gap. |

## Phase 0: Provisioning (tesserix-k8s, merge first)

1. Add `k8s/operators/zitadel/claims/kora.yaml`.
   - `ZitadelProject` `kora` in org TESSERIX, with `access: public`.
   - Native apps `kora-ios` and `kora-android`, with `refreshToken: true` and redirect `kora:/auth/callback`.
   - Set `loginBaseUri` to `/ui/v2/login`.
   - The operator always creates these as JWT access tokens (Q1, resolved). The mobile app sends the **access token** as the bearer, the same way mark8ly mobile-admin does, not the ID token as HomeChef does.
2. Update `istio-auth-policies.yaml`.
   - Append the Kora project ID to the **existing** `-agentgateway-zitadel` audiences.
   - Append `kora-api.tesserix.app` to its `restrictToHosts`.
3. Update the AgentGateway JWT policy so it accepts the Zitadel issuer and Kora audience on `X-Kora-End-User-Token`.
4. Create a machine user for API-side account deletion, scoped as narrowly as possible (Q2). Put its key in OpenBao `kora/app/zitadel-*` and deliver it via ExternalSecret.
5. Optional: Kora branding via a project/org label policy.

## Phase 1: API (kora `api/`)

1. Replace `NewFirebaseVerifier` with a go-oidc `ZitadelVerifier`.
   - Model it on `tesserix-home/platform-auth` (`oidc.go`, `verify.go`).
   - Issuer is `https://auth.tesserix.app`; pin `aud` to the project ID.
   - It returns the same `Claims{UID: sub, Email, Name}`, so middleware, `EnsureUser` and downstream code are unchanged.
2. Delete `account_status.go`.
   - Rely on local JWT validation with a short access-token TTL (5–10 min).
   - Write ADR 0007 superseding ADR 0006.
3. Implement `IdentityDeleter` against Zitadel `DELETE /v2/users/{id}` using the machine-user JWT profile.
   - Keep the `deletion.go` ordering.
   - Rename `firebase_identity_removed` → `identity_removed`.
4. Add migration `firebase_uid` → `idp_subject` (D5). Update the GORM tag, `UpsertByFirebaseUID`, `IDByFirebaseUID`, and the conformance seed.
5. Config:
   - Add `ZITADEL_ISSUER`, `ZITADEL_PROJECT_ID`, `ZITADEL_DELETER_KEY`.
   - Remove `FIREBASE_*` and the `firebase.google.com/go/v4` dependency.
   - Remove the dummy service-account step in CI (`ci.yml:89-101`).
6. Remove the Firebase-era Apple plumbing (D7).
   - Delete `internal/appleid`, `user/apple_handler.go` and the route.
   - Remove the Apple revoke step from `deletion.go`.
   - Add a migration dropping `users.apple_refresh_token`.
   - Remove `APPLE_*` from config and `main.go`.
   - Drop the `has_apple_token` / `apple_token_revoked` fields from admin responses, and the matching tesserix-home `kora-admin.ts` fields in the same change.
7. Add `/v1/app-config` (D6).
8. Update `cmd/aieval` and `cmd/aidecide` to obtain a Zitadel end-user token (Q3).

## Phase 2: Mobile (kora `apps/mobile/`)

1. Add `src/auth/zitadel.ts`: PKCE authorize, code exchange, refresh, and end_session logout.
   - Store tokens in SecureStore key `kora.zitadel.session` with `AFTER_FIRST_UNLOCK`, so background drains still work.
2. Add a small auth store to replace the Firebase surface:
   - `getAccessToken()`, which refreshes when less than 60 s remain
   - `forceRefresh()`
   - `subscribe()`
   - `currentUserId()` (`sub`)
   - `signOut()`
3. Rewire these consumers:
   - `src/lib/api.ts`: token, then 401 → refresh → `signOutForExpiredSession`
   - `authState.ts`, `(tabs)/_layout.tsx`, `more.tsx`, `delete-account.tsx`, `_layout.tsx`
   - `drainTriggers.ts`, `push.ts`, `useWidgetSync.ts`
4. On first launch of the new build, clear the offline queue and the `kora.lastOwnerId` owner state. Old Firebase-UID-stamped items can never drain.
5. Reduce `sign-in.tsx` to **Continue** and **Create account** (`prompt=create`). Keep `?reason=expired`.
6. Delete:
   - `firebase.ts`, `firebaseConfig.ts`, `firebaseAuthMessage.ts`, `secureAuthStorage.ts` (Firebase-key adapter), `socialAuth.ts`, `socialCredentials.ts`, `link.ts`, `LinkAccountPrompt.tsx`, `AppleSignInButton.tsx`, and their tests
   - `GoogleService-Info.plist`, `firebase.json`, the google-signin plugin and `iosUrlScheme`, `ios.googleServicesFile`, and Android `GOOGLE_SERVICES_JSON`
   - the `firebase` and `@react-native-google-signin/google-signin` dependencies
   - `expo-apple-authentication` and `ios.usesAppleSignIn` (D7)
7. Config: add `EXPO_PUBLIC_ZITADEL_ISSUER`, `_PROJECT_ID`, `_CLIENT_ID` (per platform) in `eas.json`. Point `config-missing` at them. Register the `kora` scheme in `app.json`.
8. Add the min-build gate screen (D6).
9. Device test:
   - register and sign in with email, Apple and Google
   - cold-start refresh
   - background offline drain
   - widget
   - push registration
   - delete account, then confirm the Zitadel user is gone
   - sign out and sign in as a different user

## Phase 3: Cutover

1. **Wipe testers (D1).** Run each existing user through the admin delete (`DELETE /v1/admin/users/:id`) on the *current* build. This revokes Apple tokens, deletes data, avatars and Firebase identities.
   - Verify `users` is empty and Firebase `accounts:batchGet` returns nothing.
   - Needs human sign-off: it destroys prod rows.
2. Deploy Phase 1, which includes the column rename.
3. Ship the Phase 2 build to TestFlight / internal track. Testers re-register.
4. Watch the API for Firebase-issuer 401s from old builds, and ping those testers to update.

## Phase 4: Cleanup

1. In tesserix-k8s:
   - Remove the `-kora` GIP entry from `istio-auth-policies.yaml`.
   - Remove the AgentGateway Firebase rule.
   - Remove `FIREBASE_*` and `APPLE_*` from `charts/apps/kora-api/values.yaml`.
   - Remove the `kora-apple-*` ExternalSecret entries and their OpenBao keys.
2. Replace `docs/runbooks/kora-firebase-identity-deletion.md` with a Zitadel equivalent, and fix the stale `api/.env.example`.
3. After human sign-off, remove the custom IAM role `koraFirebaseUserDelete` and disable Firebase Auth on `kora-app-e6d38`. Leave the GCP project itself until confirmed nothing else uses it.

## Rollback

Before Phase 3 step 1, rollback is "don't ship".

After the wipe, rollback means redeploying the previous API and app build. Testers would re-register on Firebase. That is acceptable for an internal-only population.

## Open questions

- **Q1: JWT access tokens. Resolved, no change needed.**
  - `tesserix-operators` `operators/zitadel/internal/zitadelapi/client.go:234` hardcodes `accessTokenType: OIDC_TOKEN_TYPE_JWT` on create and update for every app, native ones included.
  - The audience comes from the `urn:zitadel:iam:org:project:id:{pid}:aud` scope.
  - Mark8ly mobile-admin already passes JWT access tokens through the `-agentgateway-zitadel` rule.
  - The operator does not assert roles in tokens. Kora doesn't need that, because all end users are equal.
- **Q2: Least-privilege deletion.** `ORG_USER_MANAGER` on TESSERIX can delete any product's users. Options are a project-scoped grant, or routing deletion through platform-api. Decide before granting.
- **Q3: Eval token.** Zitadel has no password grant. Options:
  - a dedicated eval human user with a refresh token in OpenBao
  - a machine user via `jwt-bearer` with the Kora audience; `EnsureUser` would provision it like a normal user
- **Q4: Apple revocation on deletion** (App Store 5.1.1(v)). **Unsolved on the platform. This blocks App Store submission, not the migration.**
  - **What the other apps do:**
    - HomeChef revoked with native code capture, the same as Kora's `internal/appleid`. Its switch to hosted login (`3aa11883`) removed the capture, so revocation is now a no-op for new Apple users. It also never deletes the Zitadel user.
    - Mark8ly deletes the Zitadel user but never revokes Apple. Its IdP-intent code ignores `idpInformation.oauth`.
    - No workspace doc says whether Zitadel revokes Apple grants itself.
  - **After the switch:** Apple grants are issued to Services ID `com.tesserix.signin.web`. We own its key (`946A8XWHKB`), so our backend *can* call `/auth/revoke` with it, provided we can obtain a token for the user.
  - **Decision (D7):** Kora does not solve this locally. Kora's part is deleting the Zitadel user, which also removes its IdP links.
  - **Platform issue:** tesserix/tesserix-k8s#1388, covering HomeChef and mark8ly too. Spike upstream Zitadel v4.15:
    1. Does it store the Apple `refresh_token` or `access_token`, or return them via `RetrieveIdentityProviderIntent` / IdP links? Apple's revoke accepts either.
    2. Does deleting a user or removing an IdP link call Apple's revoke?
  - **Likely shape:** a platform deletion hook (Zitadel Actions v2 on user removal, or platform-api) that revokes with the `com.tesserix.signin.web` key.
  - This must land before Kora's next App Store submission.
- **Q5: Display name.** Confirm that new Apple users through Zitadel carry `name` in the ID token on first sign-in, so `EnsureUser` can seed `display_name`. Note that `isAutoUpdate` is off.
