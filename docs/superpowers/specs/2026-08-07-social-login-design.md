# Social login — Sign in with Apple + Google (#108)

Design for #108. Ports mark8ly's proven implementation to Kora's Firebase JS SDK.

## Why this comes before #106

Apple has required since June 2022 that an app offering Sign in with Apple
**revoke the Apple refresh token** on account deletion — a separate REST call to
Apple's `/auth/revoke`, which `deleteUser()` does not perform. Building #106
first means writing the deletion path twice: once for email/password, again once
providers land. #108 first means #106 is designed once against the final
provider set.

Prod currently holds **5 users, all onboarded** — effectively no population to
protect, so linking policy can be chosen freely and nobody is migrated.

## Scope

Both Apple and Google ship in R1. App Store Review Guideline 4.8 requires an
equivalent privacy-preserving option alongside a third-party login, so Google
alone would be a rejection; Apple alone would be compliant, but shipping both
before the first external install avoids account-linking work on accounts that
already hold real logs.

Email/password remains, untouched. This is additive.

## Prior art: mark8ly

`../mark8ly` has a complete implementation of the same feature:

    packages/mobile-shared/auth/social-credentials.ts   sign-in + conflict detection
    packages/mobile-shared/auth/link.ts                 re-auth-then-link handshake
    packages/mobile-shared/auth/errors.ts               error types + user-facing copy
    apps/mobile-admin/lib/social-auth.ts                native credential acquisition
    apps/mobile-admin/components/auth/LinkAccountPrompt.tsx
    apps/mobile-admin/__tests__/{link,social-credentials,social-auth,LinkAccountPrompt,login,security}.test.tsx

It already handles the things that are easy to miss: Apple's
first-authorization-only name, Hide My Email, Google's SDK *resolving* with
`{type:"cancelled"}` instead of rejecting, and a link prompt that fails open
when the sign-in-method lookup returns nothing.

**The incompatibility.** mark8ly is on `@react-native-firebase/auth` v24 (native
module). Kora is on the `firebase` JS SDK v12.16 web build, initialised with
`initializeAuth` + `getReactNativePersistence(AsyncStorage)` in
`src/lib/firebase.ts`. Every mark8ly auth call uses the namespaced native API
(`auth().signInWithCredential`, `auth.GoogleAuthProvider`,
`user.linkWithCredential`); none of it runs as-is on Kora.

**Decision: port the logic to the JS SDK.** Every API mark8ly uses has a modular
JS-SDK equivalent — `signInWithCredential(auth, cred)`,
`linkWithCredential(user, cred)`, `OAuthProvider("apple.com").credential({...})`.
Native credential acquisition (`expo-apple-authentication`,
`@react-native-google-signin/google-signin`) is identical either way, since those
are separate native modules that hand back an ID token.

Rejected alternatives:

- **Migrate Kora to `@react-native-firebase/auth`.** Closest to proven code, but
  rewrites `lib/firebase.ts`, `sign-in.tsx`, `more.tsx`, `api.ts`'s token path,
  and every test mocking `firebase/auth` — immediately before the TestFlight
  build, in the layer with no crash reporting behind it (#104 is open). Also
  contradicts this issue's own criterion that `getIdToken()` and
  `fetchWithRetry`'s refresh/401 handling stay unchanged.
- **Extract a shared cross-repo package.** kora and mark8ly are separate git
  repos with no workspace linking them; this means publishing and versioning to
  GHCR, and still requires the SDK migration first.

Accepted cost: two copies of the logic, which will drift.

### Two things not copied from mark8ly

**The nonce.** `signInWithAppleNative` returns `rawNonce: ""`, commented as
parity with Home-Chef because "GIP verifies Apple's token without a client nonce
in their setup", and explicitly flagged there as needing revisiting. Kora's
`kora-app-e6d38` is a plain Firebase project, not a GIP tenant, so that argument
does not transfer. Kora generates a real nonce: random value via `expo-crypto`,
SHA-256 sent to Apple as `nonce`, raw value passed to
`OAuthProvider.credential`. `expo-crypto` is already a dependency.

**`existingSignInMethods` as a primary mechanism.** It wraps
`fetchSignInMethodsForEmail`, which is deprecated in newer SDKs and returns `[]`
whenever email-enumeration protection is on. It is a hint only; the prompt must
work when it returns nothing.

## Server changes

`api/internal/auth` and `EnsureUser` are already provider-agnostic: `Verify`
validates any Firebase token, `EnsureUser` keys on `firebase_uid`, and
`users.email` is nullable — so an Apple private-relay sign-in already produces a
valid Kora user with no change. One change is nonetheless required.

### `PATCH /v1/me` accepting `display_name`

Nothing in `api/` ever writes `users.display_name`. `UpsertByFirebaseUID`
propagates only `firebase_uid` and `email` (`internal/user/repository.go:22`),
and no handler sets it. Verified in prod: **5 users, 0 with a display name.**

It *is* read — friends list, leaderboard, group members, challenge standings,
and `app/capture.tsx:1061`'s greeting, which falls back to "there".

This collides with the one irrecoverable fact in this issue: **Apple returns
`fullName` only on first authorization, ever.** mark8ly writes it via
`updateProfile({displayName})` into the Firebase profile — which in Kora reaches
nothing, because `EnsureUser` does not read it. Porting verbatim would discard
the only name Apple will ever offer, for every R1 Apple signup.

So: add `PATCH /v1/me` taking `display_name`, alongside the existing
`PATCH /me/share-progress`, and call it after a first-authorization Apple
sign-in. The value is trimmed, must be non-empty after trimming, and is bounded
at **100 characters, counted in runes rather than bytes** — long enough for any
real name, short enough that the friends list and leaderboard cannot be broken
by a pathological one. Runes matter because the only caller is the Apple
sign-in flow, which returns whatever name is on the user's Apple ID; a byte
bound would reject a 40-character CJK name. It writes
only the caller's own row, resolved from `user.IDFromContext`; there is no
user-id parameter to forge.

Rejected: having `auth.Claims` read the token's `name` claim. That claim only
appears after `updateProfile` **plus** a token refresh — an ordering dependency
that works in testing and fails intermittently on a real first launch.

## Mobile file layout

New — `apps/mobile/src/auth/`, a domain folder alongside `src/offline/`:

- **`errors.ts`** — `AuthCancelledError`, `LastSignInMethodError`. Firebase-free,
  so route files can catch them without pulling the auth chain into their import
  graph. No Kora equivalent today.
- **`socialCredentials.ts`** — port of mark8ly's `social-credentials.ts`.
  `signInWithGoogleCredential` / `signInWithAppleCredential` returning the
  `SocialSignInOutcome` union (`signed-in` | `needs-link`), plus the
  unverified-JWT email decode used only as a UX hint for the link prompt.
- **`link.ts`** — port of mark8ly's `link.ts`: `completeLinkWithPassword` /
  `WithGoogle` / `WithApple`, `existingSignInMethods`, and the
  `auth/reauth-failed` tagging.

New — **`apps/mobile/src/lib/socialAuth.ts`**. Native credential acquisition
ported from mark8ly's `lib/social-auth.ts`: `configureGoogleSignin`,
`signInWithGoogleNative`, `signInWithAppleNative` (with the real nonce).

New — **`apps/mobile/src/components/auth/LinkAccountPrompt.tsx`**. Ported
including its fail-open method selection. Restyled to Kora's design system
(`Card`, `Button`, `AppText`, `useTheme`), not mark8ly's NativeWind classes.

Modified:

- **`app/sign-in.tsx`** — two provider buttons above the existing email/password
  form. The mode segmented control and password path are unchanged.
- **`src/lib/firebaseAuthMessage.ts`** — extend the existing map with
  `auth/reauth-failed`, `auth/credential-already-in-use`,
  `auth/provider-already-linked`, `auth/requires-recent-login`,
  `ERR_REQUEST_UNKNOWN`; add the `AuthErrorContext` tag parameter.

**Out of scope (YAGNI):** mark8ly's `security.tsx` manage-sign-in-methods screen,
and therefore `linkedProviderIds` / `unlinkProvider`. The `needs-link` flow
handles the only case R1 hits. Note for #106: it will want `linkedProviderIds`
to decide whether an Apple token needs revoking.

## Configuration

- `app.json`: `ios.usesAppleSignIn: true`; `expo-apple-authentication` plugin;
  `@react-native-google-signin/google-signin` plugin with `iosUrlScheme`.
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` in
  `.env`, `.env.example`, and all three `eas.json` profiles.
- Firebase console: enable Apple and Google providers on `kora-app-e6d38`.
- Apple Developer: Sign in with Apple capability on the `com.tesserix.kora` App
  ID; Services ID and key for Firebase's Apple provider config.

Both providers are native modules, so this requires a native rebuild — see
`apps/mobile/AGENTS.md`.

## Flows

**A — Apple, new user.** Generate a random nonce (`expo-crypto`); send its
SHA-256 to `AppleAuthentication.signInAsync({ nonce: hashed })`; pass the **raw**
nonce plus `identityToken` to `OAuthProvider("apple.com").credential({ idToken,
rawNonce })`; `signInWithCredential`. On success, if `fullName` is present and
the user has no name, write it to the Firebase profile, then `PATCH /v1/me`.
Then `router.replace("/")`; the existing `(tabs)/_layout` onboarding gate takes
over unchanged. Hide My Email is a non-event — the relay address lands in
`users.email`, which is nullable and never used as a key.

**B — Google, new user.** `configureGoogleSignin()` → `hasPlayServices` →
`signIn()` → ID token → `GoogleAuthProvider.credential` →
`signInWithCredential`. No first-authorization-only data, so no name capture.

**C — collision.** `signInWithCredential` throws
`auth/account-exists-with-different-credential`. `socialCredentials.ts` catches
**only** that code and returns `{ status: "needs-link", email, provider,
pendingCredential }`; every other error propagates. `sign-in.tsx` renders
`LinkAccountPrompt`. The user re-authenticates with the method the account
already has, then `linkWithCredential(pending)` attaches the new provider, and
both buttons work thereafter. The method list is a hint: when it returns `[]`,
the prompt fails open and offers every option rather than dead-ending on Cancel.

**D — cancel.** Apple's `ERR_REQUEST_CANCELED` rejection and Google's
`{type:"cancelled"}` resolution are both normalised to `AuthCancelledError`.
Callers render nothing.

The email/password path is untouched, and `getIdToken()` / `fetchWithRetry`'s
401 refresh handling never enter any of these flows.

## Error handling

`firebaseAuthMessage` remains the single source of user-facing auth copy.

- **`null` means cancelled** — callers render nothing.
- **Never surface `e.message`** — native SDK strings carry Swift file paths and
  internals.
- **Disambiguate by tag, never by code.** `auth/invalid-credential` means "wrong
  password" from the re-auth step and "expired credential" from the link step —
  same code, different messages. `link.ts` tags the re-auth call site with
  `auth/reauth-failed`; nothing branches on the raw code. Kora's existing
  grouping of `invalid-credential` / `wrong-password` / `user-not-found` into one
  message for enumeration safety stays as-is.

`configureGoogleSignin` throws immediately if
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is absent, rather than letting the call reach
Play Services and fail with an opaque `DEVELOPER_ERROR`. Matches Kora's existing
`isFirebaseConfigured` / `config-missing.tsx` precedent.

**Name-capture ordering.** Write the Apple name to the Firebase profile
**first**, then `PATCH /v1/me`. If the PATCH fails on a flaky first launch, the
user is still signed in and the name survives in the Firebase profile for a
later re-sync from `auth.currentUser.displayName`. Making the PATCH fatal would
block entry over a cosmetic field; firing it without the Firebase write first
would discard irrecoverable data.

## Testing

Port the intent of mark8ly's six test files, adapted to JS-SDK mocks. Per the
#110 lesson — *an assertion whose expected value equals the initial state cannot
distinguish "it worked" from "nothing ran"* — each of these is written so a
broken implementation produces a **presence**, not the initial state:

- **Nonce.** Assert `signInAsync` received the SHA-256 **hash** and
  `OAuthProvider.credential` received the **raw** value. Both are strings, so
  swapping them is the plausible bug and a weaker assertion would not catch it.
- **Pending credential identity.** Assert the credential passed to
  `linkWithCredential` is the *same* one the conflict produced — not merely that
  link was called.
- **Cancellation.** Reach a state where an error message is rendered, *then*
  cancel, and assert it is gone. Asserting "no error shown" from a fresh mount
  would pass against a component that never renders errors at all.
- **Name capture.** Assert `PATCH /v1/me` called with the exact composed name;
  and separately that it is **not** called when `fullName` is absent or the user
  already has a name.
- **Fail-open.** `existingSignInMethods` returning `[]` renders all offered
  controls.
- **Tag disambiguation.** The same Firebase code thrown from the re-auth step and
  from the link step yields different copy.
- **Server.** Table test on `PATCH /v1/me`: trimming, rejection of
  empty-after-trim, the 100-character bound **counted in runes** (a multi-byte
  name under 100 characters but over 100 bytes must be accepted — an
  ASCII-only fixture cannot catch a byte-counting bound), and that a request
  cannot write another user's row.

Suites must stay green: `cd apps/mobile && npx tsc --noEmit && npx jest --ci
--forceExit` (122 suites / 809 tests at time of writing) and `cd api && go test
-race -p 1 ./...`.

## Device verification (required, not optional)

Both providers are native modules; green tests say nothing about whether the
build is signed and configured correctly. This must be verified on a **physical
device against prod**, per the issue's own criteria:

1. Fresh install signs in with Apple and reaches the diary.
2. Fresh install signs in with Google and reaches the diary.
3. An Apple sign-in with **Hide My Email** works end to end and can log a meal.
4. A first-authorization Apple sign-in populates `users.display_name` — verified
   by query, not by the UI.
5. A second-provider sign-in on an existing email reaches `LinkAccountPrompt`,
   links, and both buttons work afterwards.
6. Cancelling each native sheet shows no error.

## Acceptance criteria (from #108)

- A fresh device can sign in with Apple and with Google and reach the diary.
- The resulting user gets a normal Kora `users` row and can log a meal.
- A private-relay Apple account works end to end.
- Verified on a real device against prod, not the simulator.

## Open follow-ups

- Two copies of the auth logic (kora and mark8ly) will drift. Revisit sharing if
  a third consumer appears.
- Re-sync of `display_name` from `auth.currentUser.displayName` on a later launch
  is described above but not built; a failed PATCH currently leaves the name in
  Firebase only.
- #106 will need `linkedProviderIds` and Apple token revocation.
