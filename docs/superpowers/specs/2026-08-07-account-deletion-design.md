# In-app account deletion (#106)

Design for #106 — the App Review-blocking subset of #24. Apple App Store Review
Guideline **5.1.1(v)**: an app that offers account creation must also offer
in-app account deletion. Kora creates accounts and has no deletion path today.

R1 is TestFlight to ~10–30 F&F. External TestFlight goes through Beta App
Review, so this can block distribution, not merely public launch.

**Do not close #24 when this lands.** #24 is full data export plus deletion and
is correctly R3; this is deliberately the narrow subset Apple gates on.

## Why this comes after #108

Apple has required since June 2022 that an app offering Sign in with Apple
**revoke the Apple refresh token** on account deletion. Designing the deletion
path before the provider set was known would have meant writing it twice. #108
merged in PR #113.

## Decisions

| Question | Decision |
|---|---|
| Groups/challenges owned by the deleting user | **Transfer** ownership to the longest-standing remaining member; delete only if they were alone |
| Apple token revocation | **In scope** — full capture, exchange, and revoke |
| `ai_usage_events` | **Retain** with `user_id` set to NULL |
| Timing | **Immediate and irreversible** — no grace period |
| Apple refresh token at rest | **Plaintext column**, encryption recorded as a follow-up |

Rationale for each is in the sections below.

## Slicing — two PRs, in this order

**Slice 1 — capture Apple's `authorizationCode`.** Return it from
`signInWithAppleNative`, POST it to the server, exchange it with Apple for a
refresh token, store it.

**Its deadline is the moment the Apple provider is enabled in the Firebase
console** (tracked in #114). `authorizationCode` is returned **only at
sign-in**. Every Apple user created before this lands has no authorization
code, therefore no refresh token, therefore **can never be revoked** — they
would have to sign out and back in to repair it. Nobody has signed in with
Apple yet, so today this costs nothing and affects no one.

This is #108's own "providers before the first external install" argument, one
level down.

**Slice 2 — the deletion itself.** Ownership transfer, cascade, Firebase
identity removal, the revoke call, Settings UI, confirmation screen. No deadline
beyond #109.

Shipping slice 1 first unblocks the console configuration without racing
slice 2.

## Server

New in `api/internal/user/` — the package that already owns this domain:

- **`DELETE /v1/me`** — deletes the caller's own account. No user id in the
  request; the row comes from `IDFromContext`, exactly as `PATCH /v1/me` does.
  There is nothing to forge.
- **`POST /v1/me/apple-authorization`** — accepts `{ "authorization_code": … }`,
  exchanges it with Apple, stores the refresh token on the caller's row,
  **overwriting any existing value**. Apple issues a fresh code on every
  authorization, and the newest is the one that will still be valid at deletion
  time. Returns 204; the client treats failure as non-fatal.

New package **`api/internal/appleid/`** — the only outbound Apple integration,
isolated because it owns some fiddly crypto. Takes an `*http.Client` so tests
drive it with a fake transport instead of reaching Apple.

### Migrations

1. `users.apple_refresh_token TEXT NULL` — read during deletion, then removed
   with the row.
2. `ai_usage_events.user_id` — drop `NOT NULL`; FK becomes `ON DELETE SET NULL`.

### The deletion sequence

1. Resolve the caller from `IDFromContext`.
2. **Transfer group and challenge ownership.** Must be first — once the cascade
   fires the groups are already gone.
3. **Revoke the Apple refresh token.** Before the DB delete, because the token
   lives on the `users` row. **Non-fatal**: if Apple is unreachable, log and
   continue. Blocking deletion on a third-party outage would break the one thing
   Apple actually requires — that deletion completes in-app.
4. **`DELETE FROM users WHERE id = ?`** — one statement, 18 cascades. On
   failure, abort with 500 and touch nothing else. Fully retryable.
5. **Delete the Firebase identity** via the Admin SDK.
6. **204.** The client signs out.

### Why steps 4 and 5 are in that order

This is the load-bearing decision in the design.

If Firebase deletion fails *after* the DB delete, the personal data — the thing
deletion exists to remove — is already gone. The identity lingers, so the user
can sign in and `EnsureUser` provisions a fresh, empty row. Momentarily
confusing, harmless, and critically **self-healing**: they delete again, the now
trivial DB delete succeeds, and Firebase deletion gets another attempt.

Reverse the order and the failure is far worse. Delete the Firebase identity
first, then fail the DB delete, and the user can never sign in again — so nobody
can ever retry, and their personal data sits in the database forever with no
owner and no trigger to remove it. Orphaned personal data with no recovery path
is precisely what this feature exists to prevent.

Therefore a Firebase failure returns **204** and logs loudly for cleanup. From
the user's perspective their data genuinely is gone; returning 500 would be a
lie in the other direction, telling them nothing happened when everything did.

### Ownership transfer

For each group the user owns that has other members, set `owner_id` to the
member with the earliest `group_members.joined_at`, **breaking ties on
`user_id`**. Groups where they are the only member cascade away. Same rule for
challenges via `challenge_participants.joined_at`.

The tiebreak is not decoration. `joined_at` defaults to `now()`, which in
Postgres returns the **transaction start** timestamp — so two members added in
one transaction get byte-identical values and `MIN` alone is nondeterministic.
This project has already been bitten by exactly that on `coach_turns`, which
needed a `seq` column to recover a stable order.

No notifications, no UI. The goal is only to avoid destroying other people's
data. Both membership tables already carry `joined_at`, so the rule needs no
schema change.

Prod currently holds zero groups and zero challenges, so nothing migrates — but
F&F beta is exactly when friends start creating them.

### What survives

`ai_usage_events` holds `provider, model, call_type, tokens_in, tokens_out,
cost_usd_est, latency_ms, outcome` — no meal content, no free text, nothing
personal beyond `user_id`. It is also the table **#43 depends on** for "AI calls
per active user/month" and "Σ est_cost per user", the numbers that gate pricing
in #41. Cascading it means every deletion silently removes cost history from the
denominator — and Apple *requires* a deletable demo account, so at least one
deletion is guaranteed.

Nulling `user_id` leaves anonymous cost records attributable to nobody, which is
not personal data by any reasonable reading.

`feedback` deliberately **does** cascade. It is free text a user typed and can
contain anything, including things about themselves; anonymising the author does
not anonymise the content.

`kora_admin_events` has no FK to `users` and is untouched — as #106 requires.

### The Apple refresh token at rest

Stored as a plain `TEXT` column with a comment scoping what it permits:
refreshing or revoking **this app's** Sign in with Apple relationship for that
user. It grants no access to their Apple account or their Kora account.

`kora_db` is owned by the `kora` role and is a separate database, not shared
tables — the other apps on the cluster have their own databases. The token
therefore sits no more exposed than any other column in the same row.

Recorded honestly as a follow-up rather than dismissed: it is a credential
rather than data, and it lands in backups. Encryption is AES-GCM with a key from
Secret Manager, roughly 40 lines plus rotation. Deferred as disproportionate for
R1, not as unnecessary.

## The Apple integration

**`client_id` is the bundle identifier `com.tesserix.kora`, NOT a Services ID.**
The authorization code comes from `expo-apple-authentication`, which is the
native iOS flow, and Apple expects the bundle ID there. A Services ID is for the
web/Android flow. Getting this wrong yields a bare `invalid_client` with no
further explanation — a miserable thing to debug on a device.

Firebase's own Apple provider config still needs a Services ID for *its* web
flow. The two are separate and both exist.

Three operations:

- **Client secret** — an ES256 JWT signed with the `.p8` key: header
  `{alg: "ES256", kid: keyID}`, claims `{iss: teamID, aud:
  "https://appleid.apple.com", sub: bundleID, iat, exp}`. Apple permits up to
  six months, but there is no reason to store one: **sign a fresh five-minute
  JWT per request.** That removes the rotation story entirely and leaves the
  `.p8` key as the only long-lived secret.
- **Exchange** — `POST https://appleid.apple.com/auth/token`,
  `grant_type=authorization_code`. Returns the refresh token.
- **Revoke** — `POST https://appleid.apple.com/auth/revoke`,
  `token_type_hint=refresh_token`.

### Secrets to provision (human, like #114)

- Apple **Team ID**
- **Key ID** and the `.p8` private key (Sign in with Apple key)
- Bundle ID is already known: `com.tesserix.kora`

Via GCP Secret Manager → env, following the existing `GEMINI_API_KEY` pattern in
`api/internal/config/config.go`.

## Mobile

- **`app/settings.tsx`** gains a destructive "Delete account" row. It is 48
  lines today, so there is room.
- **`app/delete-account.tsx`** — a dedicated confirmation screen, not an
  `Alert`. Names exactly what goes (logs, saved meals, weight and water history,
  friends, coach conversations), states it cannot be undone, and requires typing
  `delete` before the button enables. Irreversible and sitting in a settings
  list beside harmless toggles, so a single tap is not enough protection.
- On success: `signOut(auth)`, then `router.replace("/sign-in")`.
- **`socialAuth.ts`** returns `authorizationCode`;
  **`socialCredentials.ts`** forwards it to the server **non-fatally** — same
  shape and reasoning as #108's display-name write. A failed capture must not
  block sign-in.
- All failure copy comes from the existing mappers. Never a raw
  `error.message`, consistent with #108.

## Testing

Per the #110 lesson — *an assertion whose expected value equals the initial
state cannot distinguish "it worked" from "nothing ran"* — each of these is
written so a broken implementation produces a presence, not the initial state.

- **The cascade is verified by query, never by a 204.** Seed rows for the user
  across `food_logs`, `saved_meals`, `weight_entries`, `pins`, and
  `device_tokens`; delete; assert each is gone.
- **A second user's rows are asserted intact in the same test.** Without this, a
  `DELETE FROM users` missing its `WHERE` clause passes every other assertion in
  the suite. **This is the single most important test here.**
- **`ai_usage_events` rows survive with `user_id IS NULL`** — asserted
  positively, so a cascade regression fails.
- **`kora_admin_events` is untouched** — seed one referencing the user first, so
  the assertion is a presence rather than the initial empty state.
- **Ownership transfer** — a group with two other members transfers to the
  earlier `joined_at`; a solo group cascades. Both asserted by query.
- **Failure model** — a stubbed Firebase deleter that errors still yields 204
  with the DB rows gone; a failing DB delete yields 500 **and leaves the
  Firebase identity untouched**, verified by asserting the fake deleter was
  never called.
- **Apple** — the client-secret JWT's header and claims are pinned; exchange and
  revoke are driven through a fake transport asserting method, URL, and form
  fields, **including that `client_id` is the bundle ID**.
- **Mobile** — the Settings row routes correctly; the confirm button stays
  disabled until `delete` is typed exactly; success signs out and navigates.

Suites must stay green: `cd apps/mobile && npx tsc --noEmit && npx jest --ci
--forceExit` and `cd api && go test -race -p 1 ./...`.

## Acceptance criteria (from #106)

- A test account can be deleted from inside the app.
- Its rows are gone (or anonymised) across every table — **verified by query,
  not by the UI reporting success**.
- The GIP/Firebase identity is removed; the same email can register fresh
  afterwards.
- Deletion does **not** cascade away `kora_admin_events`.

Additionally, from this design:

- The Apple refresh token is revoked, verified against Apple's response.
- A group with other members survives its owner's deletion, with a new owner.

## Device verification

Requires a physical device against prod, for the same reason as #108: the Apple
capture path runs through a native module.

1. Sign in with Apple, then delete the account from Settings; confirm the rows
   are gone **by query**.
2. Confirm the same Apple ID can sign in again afterwards and gets a fresh,
   empty account.
3. Confirm `ai_usage_events` rows for that user remain with `user_id IS NULL`.

## Open follow-ups

- Encryption at rest for `apple_refresh_token`.
- No grace period or restore flow. Deliberate for R1; addable later without
  migrating anything.
- Existing Apple users created before slice 1 lands cannot be revoked. Expected
  to be zero if slice 1 ships before the console configuration in #114.
