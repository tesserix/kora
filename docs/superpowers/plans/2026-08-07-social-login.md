# Social Login (Apple + Google) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign in to Kora with Apple or Google, alongside the existing email/password flow, and link a second provider onto an existing account.

**Architecture:** Port mark8ly's proven implementation (`../mark8ly/packages/mobile-shared/auth/`) from `@react-native-firebase/auth` to Kora's `firebase` JS SDK v12. Native modules acquire a provider ID token; the JS SDK exchanges it for a Firebase session. A collision on an existing email returns a `needs-link` outcome that a modal resolves by re-authenticating then calling `linkWithCredential`. One new server endpoint persists the Apple display name, which Apple returns only once.

**Tech Stack:** Expo SDK 57 / React Native, TypeScript, `firebase` JS SDK v12.16, `expo-apple-authentication`, `@react-native-google-signin/google-signin`, `expo-crypto`, `base64-js`, Jest + `@testing-library/react-native`, Go 1.26 + Gin + GORM.

**Spec:** `docs/superpowers/specs/2026-08-07-social-login-design.md`
**Issue:** #108
**Branch:** `feat/social-login-108` (already exists, spec committed at `8818b67`)

## Global Constraints

- Commits: conventional prefix, **single line**, no body, no trailers, no signature.
- Expo dependencies are installed with `npx expo install <pkg>`, **never** plain `npm install`.
- `npx expo lint` regenerates `apps/mobile/eslint.config.js`, which is untracked **on purpose**. Never stage it. Check `git status` before every `git add`.
- Mobile suite must stay green: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit` — 122 suites / 809 tests at plan time.
- Go suite: `cd api && go test -race -p 1 ./...` with `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'` (container `kora-pg-test`; run `go run ./cmd/migrate` first).
- Firebase project is `kora-app-e6d38`. It is a **plain Firebase project, not a GIP tenant** — do not copy mark8ly's GIP-specific choices without re-deriving them.
- `firebaseAuthMessage` is the single source of user-facing auth copy. Never render `e.message` — native SDK strings carry Swift file paths.
- Never disambiguate auth errors by Firebase code alone where two steps share a code. Tag at the throw site.
- Test rule, from the #110 review: **an assertion whose expected value equals the initial state cannot distinguish "it worked" from "nothing ran".** Every absence assertion must first reach a state where a wrong implementation would produce a presence.
- Kora's design system: `AppText`, `Button`, `Card`, `Segmented`, `useTheme` from `@/components/*` and `@/theme`. Do not introduce NativeWind classes (mark8ly uses them; Kora does not).

---

### Task 1: Server — `PATCH /v1/me` accepting `display_name`

Nothing in `api/` writes `users.display_name` today, yet five screens read it. Apple returns a name only on first authorization, so without this endpoint that name is discarded forever.

**Files:**
- Modify: `api/internal/user/repository.go` (add `SetDisplayName` after `SetShareProgress`, ~line 90)
- Modify: `api/internal/user/handler.go` (add `UpdateProfile` after `UpdateShareProgress`)
- Modify: `api/internal/server/router.go:95` (add route next to `PATCH /me/share-progress`)
- Test: `api/internal/user/handler_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `PATCH /v1/me` with body `{"display_name": string}`, returning the full `User` JSON envelope. `Repository.SetDisplayName(ctx context.Context, id uuid.UUID, name string) error`.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/user/handler_test.go`:

```go
func newProfileRouter(t *testing.T, db *gorm.DB, uid, email string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: uid, Email: email}}
	repo := NewRepository(db)
	h := NewHandler(repo)
	r.PATCH("/v1/me", auth.Middleware(v), ResolveMiddleware(repo), h.UpdateProfile)
	return r
}

func patchProfile(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPatch, "/v1/me", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer anything")
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestUpdateProfileSetsDisplayName(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-name") })
	r := newProfileRouter(t, db, "test-uid-name", "name@test.dev")

	w := patchProfile(t, r, `{"display_name":"  Ada Lovelace  "}`)

	require.Equal(t, http.StatusOK, w.Code)
	// Asserts the TRIMMED value, so an implementation that skips trimming fails.
	assert.Contains(t, w.Body.String(), `"display_name":"Ada Lovelace"`)

	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-name").Scan(&got)
	assert.Equal(t, "Ada Lovelace", got)
}

func TestUpdateProfileRejectsEmptyAfterTrim(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-empty") })
	r := newProfileRouter(t, db, "test-uid-empty", "empty@test.dev")

	// Seed a real name first, so "unchanged" is a PRESENCE, not the initial
	// empty string — otherwise this passes against a handler that writes
	// nothing at all.
	require.Equal(t, http.StatusOK, patchProfile(t, r, `{"display_name":"Grace"}`).Code)

	w := patchProfile(t, r, `{"display_name":"   "}`)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-empty").Scan(&got)
	assert.Equal(t, "Grace", got)
}

func TestUpdateProfileRejectsOverLengthAndLeavesRowIntact(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-long") })
	r := newProfileRouter(t, db, "test-uid-long", "long@test.dev")
	require.Equal(t, http.StatusOK, patchProfile(t, r, `{"display_name":"Grace"}`).Code)

	long := strings.Repeat("a", 101)
	w := patchProfile(t, r, `{"display_name":"`+long+`"}`)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-long").Scan(&got)
	assert.Equal(t, "Grace", got)
}

func TestUpdateProfileAcceptsExactlyMaxLength(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-max") })
	r := newProfileRouter(t, db, "test-uid-max", "max@test.dev")

	exact := strings.Repeat("a", 100)
	w := patchProfile(t, r, `{"display_name":"`+exact+`"}`)

	// Pins the boundary as inclusive: an off-by-one `>= 100` guard fails here.
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestUpdateProfileWritesOnlyTheCallersRow(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() {
		db.Exec("DELETE FROM users WHERE firebase_uid IN (?, ?)", "test-uid-a", "test-uid-b")
	})
	// Two real users. The second must be untouched by the first's request.
	rb := newProfileRouter(t, db, "test-uid-b", "b@test.dev")
	require.Equal(t, http.StatusOK, patchProfile(t, rb, `{"display_name":"Bob"}`).Code)

	ra := newProfileRouter(t, db, "test-uid-a", "a@test.dev")
	require.Equal(t, http.StatusOK, patchProfile(t, ra, `{"display_name":"Alice"}`).Code)

	var bName string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-b").Scan(&bName)
	assert.Equal(t, "Bob", bName)
}
```

Add `"strings"` to the import block of `handler_test.go`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' \
  go test ./internal/user/ -run TestUpdateProfile -v
```

Expected: compile failure — `h.UpdateProfile undefined`.

- [ ] **Step 3: Add the repository method**

In `api/internal/user/repository.go`, after `SetShareProgress`:

```go
func (r Repository) SetDisplayName(ctx context.Context, id uuid.UUID, name string) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("display_name", name).Error; err != nil {
		return fmt.Errorf("user: set display name: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Add the handler**

In `api/internal/user/handler.go`, after `UpdateShareProgress`. Add `"strings"` and `"unicode/utf8"` to the imports.

```go
// MaxDisplayNameLen bounds the name at a length no real name exceeds, so a
// pathological value cannot break the friends list or leaderboard layouts.
// Counted in RUNES, not bytes: the only caller is the Apple sign-in flow, which
// returns whatever name the user set on their Apple ID, so non-ASCII input is
// expected. A byte bound would reject a 40-character CJK name as "too long".
const MaxDisplayNameLen = 100

type updateProfileBody struct {
	DisplayName string `json:"display_name"`
}

// UpdateProfile writes the caller's own display name. The row is resolved from
// the auth context by ResolveMiddleware — there is no user id in the request to
// forge.
func (h Handler) UpdateProfile(c *gin.Context) {
	id, ok := IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var req updateProfileBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "display name is required")
		return
	}
	if utf8.RuneCountInString(name) > MaxDisplayNameLen {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "display name is too long")
		return
	}
	if err := h.repo.SetDisplayName(c.Request.Context(), id, name); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not update profile")
		return
	}
	u, err := h.repo.ByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load profile")
		return
	}
	httpx.OK(c, u)
}
```

- [ ] **Step 5: Register the route**

In `api/internal/server/router.go`, immediately after line 95:

```go
		v1.PATCH("/me", userHandler.UpdateProfile)
```

- [ ] **Step 6: Run the tests**

```bash
cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' \
  go test ./internal/user/ -run TestUpdateProfile -v
```

Expected: all five PASS.

- [ ] **Step 7: Prove the tests are load-bearing**

Temporarily delete the `strings.TrimSpace` call (use `req.DisplayName` directly) and re-run. `TestUpdateProfileSetsDisplayName` and `TestUpdateProfileRejectsEmptyAfterTrim` must both FAIL. Restore the line.

- [ ] **Step 8: Full Go suite**

```bash
cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' \
  go test -race -p 1 ./...
```

Expected: 0 FAIL.

- [ ] **Step 9: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/user/repository.go api/internal/user/handler.go api/internal/user/handler_test.go api/internal/server/router.go
git commit -m "feat(api): accept display_name on PATCH /v1/me"
```

---

### Task 2: Auth error types and message extension

**Files:**
- Create: `apps/mobile/src/auth/errors.ts`
- Modify: `apps/mobile/src/lib/firebaseAuthMessage.ts`
- Test: `apps/mobile/src/auth/__tests__/errors.test.ts`
- Test: `apps/mobile/src/lib/__tests__/firebaseAuthMessage.test.ts` (create if absent; check first)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class AuthCancelledError extends Error` (name `"AuthCancelledError"`)
  - `class LastSignInMethodError extends Error` (name `"LastSignInMethodError"`)
  - `type AuthErrorContext = { method: "password" } | { method: "social"; provider: "google.com" | "apple.com" }`
  - `firebaseAuthMessage(error: unknown, ctx?: AuthErrorContext): string | null` — **note the return type changes from `string` to `string | null`**; `null` means "user cancelled, render nothing".

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/auth/__tests__/errors.test.ts`:

```ts
import { AuthCancelledError, LastSignInMethodError } from "@/auth/errors";

describe("auth error types", () => {
  it("AuthCancelledError is identifiable by instanceof and name", () => {
    const e = new AuthCancelledError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AuthCancelledError);
    expect(e.name).toBe("AuthCancelledError");
  });

  it("LastSignInMethodError is identifiable by instanceof and name", () => {
    const e = new LastSignInMethodError();
    expect(e).toBeInstanceOf(LastSignInMethodError);
    expect(e.name).toBe("LastSignInMethodError");
  });

  it("the two are not interchangeable", () => {
    expect(new AuthCancelledError()).not.toBeInstanceOf(LastSignInMethodError);
  });
});
```

Create `apps/mobile/src/lib/__tests__/firebaseAuthMessage.test.ts` (if a file already exists at that path, append these cases instead of overwriting):

```ts
import { firebaseAuthMessage } from "@/lib/firebaseAuthMessage";
import { AuthCancelledError, LastSignInMethodError } from "@/auth/errors";

describe("firebaseAuthMessage", () => {
  it("returns null for a cancelled sign-in so callers render nothing", () => {
    expect(firebaseAuthMessage(new AuthCancelledError())).toBeNull();
  });

  it("returns null for Apple's raw cancellation code that bypassed the wrapper", () => {
    expect(firebaseAuthMessage({ code: "ERR_REQUEST_CANCELED" })).toBeNull();
  });

  it("explains the iCloud precondition for ERR_REQUEST_UNKNOWN", () => {
    expect(firebaseAuthMessage({ code: "ERR_REQUEST_UNKNOWN" })).toContain("iCloud");
  });

  it("names the last-sign-in-method refusal", () => {
    expect(firebaseAuthMessage(new LastSignInMethodError())).toBe(
      "You can't remove your only sign-in method.",
    );
  });

  // The tag test. auth/reauth-failed and auth/invalid-credential are produced by
  // DIFFERENT steps; the same raw code cannot distinguish them, so the copy must
  // differ by tag. Three distinct outputs, asserted as mutually distinct rather
  // than against one literal, so a stub returning a constant fails.
  it("distinguishes the re-auth failure by context", () => {
    const password = firebaseAuthMessage({ code: "auth/reauth-failed" }, { method: "password" });
    const social = firebaseAuthMessage(
      { code: "auth/reauth-failed" },
      { method: "social", provider: "google.com" },
    );
    const untagged = firebaseAuthMessage({ code: "auth/reauth-failed" });

    expect(password).toBe("That password is incorrect.");
    expect(social).not.toBe(password);
    expect(untagged).not.toBe(password);
    expect(untagged).not.toBe(social);
  });

  it("never claims 'password' when no context was supplied", () => {
    expect(firebaseAuthMessage({ code: "auth/reauth-failed" })).not.toContain("password");
  });

  it("maps the link-specific codes", () => {
    expect(firebaseAuthMessage({ code: "auth/credential-already-in-use" })).toContain("already linked");
    expect(firebaseAuthMessage({ code: "auth/provider-already-linked" })).toContain("already linked");
    expect(firebaseAuthMessage({ code: "auth/requires-recent-login" })).toContain("sign in again");
  });

  it("keeps the existing enumeration-safe grouping", () => {
    const invalid = firebaseAuthMessage({ code: "auth/invalid-credential" });
    expect(firebaseAuthMessage({ code: "auth/wrong-password" })).toBe(invalid);
    expect(firebaseAuthMessage({ code: "auth/user-not-found" })).toBe(invalid);
  });

  it("never returns a raw message from an unknown error", () => {
    const msg = firebaseAuthMessage({ code: "auth/nope", message: "/Users/x/Native.swift:42 boom" });
    expect(msg).toBe("Something went wrong. Please try again.");
    expect(msg).not.toContain("Native.swift");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/mobile && npx jest src/auth/__tests__/errors.test.ts src/lib/__tests__/firebaseAuthMessage.test.ts --ci
```

Expected: FAIL — cannot resolve `@/auth/errors`.

- [ ] **Step 3: Create the error module**

`apps/mobile/src/auth/errors.ts`:

```ts
// Firebase-free error types for the auth layer. Kept out of `link.ts` and
// `socialCredentials.ts` (which value-import `firebase/auth`) so route files can
// catch these without pulling the auth chain into their import graph.

/** Thrown when unlinking would remove the user's only remaining sign-in method. */
export class LastSignInMethodError extends Error {
  constructor() {
    super("Cannot remove the only sign-in method");
    this.name = "LastSignInMethodError";
  }
}

/** The user dismissed a native sign-in sheet. Callers show NOTHING. */
export class AuthCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "AuthCancelledError";
  }
}

export type AuthErrorContext =
  | { method: "password" }
  | { method: "social"; provider: "google.com" | "apple.com" };
```

- [ ] **Step 4: Extend the message mapper**

Replace the body of `apps/mobile/src/lib/firebaseAuthMessage.ts`, keeping its existing header comment and `MESSAGES` entries:

```ts
import { AuthCancelledError, LastSignInMethodError, type AuthErrorContext } from "@/auth/errors";

// ... keep the existing header comment block unchanged ...
const MESSAGES: Record<string, string> = {
  "auth/email-already-in-use": "That email already has an account. Try signing in.",
  "auth/weak-password": "Choose a password of at least 6 characters.",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/network-request-failed": "Couldn't reach Kora. Check your connection.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  // Added for social sign-in and provider linking.
  "auth/credential-already-in-use": "That account is already linked to a different Kora account.",
  "auth/provider-already-linked": "That's already linked to your account.",
  "auth/requires-recent-login": "For security, sign out and sign in again, then retry.",
  "auth/user-disabled": "That account has been disabled. Contact support.",
  "ERR_REQUEST_UNKNOWN":
    "Couldn't complete Apple sign-in. Make sure you're signed in to iCloud on this device.",
};

const FALLBACK = "Something went wrong. Please try again.";

// `auth/reauth-failed` is a TAG set by link.ts at the re-auth call site, not a
// Firebase code. It exists because the re-auth step and the link step both
// surface `auth/invalid-credential`, meaning "wrong password" in one and
// "expired credential" in the other — the code alone cannot separate them.
function reauthFailedMessage(ctx?: AuthErrorContext): string {
  if (ctx?.method === "password") return "That password is incorrect.";
  if (ctx?.method === "social") return "Couldn't verify that account. Try again.";
  // Forgetting to pass a context must never produce confidently WRONG copy, so
  // stay neutral rather than guessing "password".
  return "Couldn't verify your account. Try again.";
}

/**
 * Returns `null` ONLY when the user cancelled — callers must render nothing.
 * Never returns a raw `error.message`: native SDK strings carry Swift file
 * paths and internals that must not reach a user.
 */
export function firebaseAuthMessage(error: unknown, ctx?: AuthErrorContext): string | null {
  if (error instanceof AuthCancelledError) return null;
  if (error instanceof LastSignInMethodError) return "You can't remove your only sign-in method.";
  if (typeof error !== "object" || error === null) return FALLBACK;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return FALLBACK;
  // Safety net for a raw Apple cancellation that bypassed the socialAuth wrapper.
  if (code === "ERR_REQUEST_CANCELED") return null;
  if (code === "auth/reauth-failed") return reauthFailedMessage(ctx);
  return MESSAGES[code] ?? FALLBACK;
}
```

- [ ] **Step 5: Fix the existing call site for the new nullable return**

`app/sign-in.tsx:61` currently does `setError(firebaseAuthMessage(e))`. `setError` accepts `string | null`, so this still type-checks and a cancel simply clears the error. Confirm with `npx tsc --noEmit` in the next step; make no change unless the compiler objects.

- [ ] **Step 6: Run tests and typecheck**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest src/auth src/lib/__tests__/firebaseAuthMessage.test.ts --ci
```

Expected: typecheck clean, all tests PASS.

- [ ] **Step 7: Prove the tag test is load-bearing**

Temporarily make `reauthFailedMessage` ignore `ctx` and always return `"That password is incorrect."`. Re-run; the "distinguishes the re-auth failure by context" and "never claims 'password'" tests must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git status   # confirm apps/mobile/eslint.config.js is NOT staged
git add apps/mobile/src/auth/errors.ts apps/mobile/src/auth/__tests__/errors.test.ts \
        apps/mobile/src/lib/firebaseAuthMessage.ts apps/mobile/src/lib/__tests__/firebaseAuthMessage.test.ts
git commit -m "feat(mobile): add auth error types and extend auth message mapping"
```

---

### Task 3: Native credential acquisition (`socialAuth.ts`) and build configuration

This task installs the native modules and configures the app, because nothing in it can be tested without them.

**Files:**
- Create: `apps/mobile/src/lib/socialAuth.ts`
- Modify: `apps/mobile/app.json`
- Modify: `apps/mobile/.env`, `apps/mobile/.env.example`, `apps/mobile/eas.json`
- Modify: `apps/mobile/package.json` (via `expo install`)
- Test: `apps/mobile/src/lib/__tests__/socialAuth.test.ts`

**Interfaces:**
- Consumes: `AuthCancelledError` from `@/auth/errors` (Task 2).
- Produces:
  - `configureGoogleSignin(): void`
  - `signInWithGoogleNative(): Promise<string>` — resolves to a Google ID token.
  - `signInWithAppleNative(): Promise<{ idToken: string; rawNonce: string; fullName: AppleFullName | null }>`
  - `interface AppleFullName { givenName?: string | null; familyName?: string | null }`

- [ ] **Step 1: Install the dependencies**

```bash
cd apps/mobile
npx expo install expo-apple-authentication @react-native-google-signin/google-signin base64-js
```

`base64-js` is present transitively (1.5.1) but is not a direct dependency; Task 4 imports it directly, so it must be declared.

- [ ] **Step 2: Write the failing tests**

Create `apps/mobile/src/lib/__tests__/socialAuth.test.ts`:

```ts
import * as Crypto from "expo-crypto";
import * as AppleAuthentication from "expo-apple-authentication";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { AuthCancelledError } from "@/auth/errors";
import { configureGoogleSignin, signInWithAppleNative, signInWithGoogleNative } from "@/lib/socialAuth";

jest.mock("expo-apple-authentication", () => ({
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(async () => true), signIn: jest.fn() },
}));

const signInAsync = AppleAuthentication.signInAsync as jest.Mock;
const googleSignIn = GoogleSignin.signIn as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "web-client-id";
});

describe("signInWithAppleNative", () => {
  it("sends the SHA-256 HASH to Apple and returns the RAW nonce for Firebase", async () => {
    // Both values are strings, so swapping them is the plausible bug and would
    // survive a weaker assertion. Pin each to the side it belongs on.
    jest.spyOn(Crypto, "digestStringAsync").mockResolvedValue("HASHED_NONCE");
    signInAsync.mockResolvedValue({ identityToken: "apple-id-token", fullName: null });

    const result = await signInWithAppleNative();

    const sentNonce = signInAsync.mock.calls[0][0].nonce;
    expect(sentNonce).toBe("HASHED_NONCE");
    expect(result.rawNonce).not.toBe("HASHED_NONCE");
    expect(result.rawNonce.length).toBeGreaterThan(0);
    // The hash must be OF the raw nonce, not of something else.
    expect(Crypto.digestStringAsync).toHaveBeenCalledWith(
      Crypto.CryptoDigestAlgorithm.SHA256,
      result.rawNonce,
    );
    expect(result.idToken).toBe("apple-id-token");
  });

  it("never reuses a nonce between calls", async () => {
    signInAsync.mockResolvedValue({ identityToken: "t", fullName: null });
    const a = await signInWithAppleNative();
    const b = await signInWithAppleNative();
    expect(a.rawNonce).not.toBe(b.rawNonce);
  });

  it("requests FULL_NAME and EMAIL scopes so a first authorisation returns a name", async () => {
    signInAsync.mockResolvedValue({ identityToken: "t", fullName: null });
    await signInWithAppleNative();
    expect(signInAsync.mock.calls[0][0].requestedScopes).toEqual([
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ]);
  });

  it("passes the fullName through untouched", async () => {
    signInAsync.mockResolvedValue({
      identityToken: "t",
      fullName: { givenName: "Ada", familyName: "Lovelace" },
    });
    const result = await signInWithAppleNative();
    expect(result.fullName).toEqual({ givenName: "Ada", familyName: "Lovelace" });
  });

  it("normalises Apple's cancellation to AuthCancelledError", async () => {
    signInAsync.mockRejectedValue({ code: "ERR_REQUEST_CANCELED" });
    await expect(signInWithAppleNative()).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("propagates a non-cancellation Apple error unchanged", async () => {
    const boom = { code: "ERR_REQUEST_UNKNOWN" };
    signInAsync.mockRejectedValue(boom);
    await expect(signInWithAppleNative()).rejects.toBe(boom);
  });

  it("throws when Apple returns no identity token", async () => {
    signInAsync.mockResolvedValue({ identityToken: null, fullName: null });
    await expect(signInWithAppleNative()).rejects.toThrow("no identity token");
  });
});

describe("signInWithGoogleNative", () => {
  it("returns the ID token from the nested data shape", async () => {
    googleSignIn.mockResolvedValue({ type: "success", data: { idToken: "google-id-token" } });
    await expect(signInWithGoogleNative()).resolves.toBe("google-id-token");
  });

  it("checks Play Services before signing in", async () => {
    googleSignIn.mockResolvedValue({ data: { idToken: "t" } });
    await signInWithGoogleNative();
    expect(GoogleSignin.hasPlayServices).toHaveBeenCalled();
  });

  // The SDK RESOLVES on cancel rather than rejecting. Untreated, this falls
  // through to the "no ID token" throw and is shown to the user as a failure.
  it("treats a RESOLVED cancellation as AuthCancelledError, not a failure", async () => {
    googleSignIn.mockResolvedValue({ type: "cancelled", data: null });
    await expect(signInWithGoogleNative()).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("throws when the SDK succeeds but yields no ID token", async () => {
    googleSignIn.mockResolvedValue({ type: "success", data: { idToken: null } });
    await expect(signInWithGoogleNative()).rejects.toThrow("no ID token");
  });
});

describe("configureGoogleSignin", () => {
  it("fails loudly when the web client id is missing", () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    expect(() => configureGoogleSignin()).toThrow("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID");
    expect(GoogleSignin.configure).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd apps/mobile && npx jest src/lib/__tests__/socialAuth.test.ts --ci
```

Expected: FAIL — cannot resolve `@/lib/socialAuth`.

- [ ] **Step 4: Implement `socialAuth.ts`**

Create `apps/mobile/src/lib/socialAuth.ts`:

```ts
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { AuthCancelledError } from "@/auth/errors";

export interface AppleFullName {
  givenName?: string | null;
  familyName?: string | null;
}

let configured = false;

export function configureGoogleSignin(): void {
  if (configured) return;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  // Fail here, loudly, rather than letting signIn() reach Play Services and
  // fail with an opaque DEVELOPER_ERROR. Same precedent as isFirebaseConfigured.
  if (!webClientId) {
    throw new Error("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not configured");
  }
  GoogleSignin.configure({
    webClientId,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  });
  configured = true;
}

export async function signInWithGoogleNative(): Promise<string> {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = (await GoogleSignin.signIn()) as {
    type?: string;
    data?: { idToken?: string | null };
    idToken?: string | null;
  };
  // The SDK RESOLVES with {type:"cancelled"} rather than rejecting, so without
  // this a cancel falls through to the throw below and reaches the user as a
  // failure.
  if (result?.type === "cancelled") throw new AuthCancelledError();
  const idToken = result?.data?.idToken ?? result?.idToken;
  if (!idToken) throw new Error("Google sign-in failed: no ID token");
  return idToken;
}

const NONCE_BYTES = 32;

function randomNonce(): string {
  return Array.from(Crypto.getRandomBytes(NONCE_BYTES))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Apple's nonce handshake: Apple receives the SHA-256 HASH and embeds it in the
 * identity token; Firebase receives the RAW value and checks it hashes to what
 * the token carries. Sending the same value to both, or swapping them, produces
 * a token Firebase rejects.
 *
 * mark8ly passes an empty rawNonce because GIP verifies Apple tokens without a
 * client nonce. kora-app-e6d38 is a plain Firebase project, so that does not
 * transfer — this generates a real nonce.
 */
export async function signInWithAppleNative(): Promise<{
  idToken: string;
  rawNonce: string;
  fullName: AppleFullName | null;
}> {
  const rawNonce = randomNonce();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  let cred: AppleAuthentication.AppleAuthenticationCredential;
  try {
    cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e: unknown) {
    const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
    if (code === "ERR_REQUEST_CANCELED") throw new AuthCancelledError();
    throw e;
  }
  if (!cred.identityToken) throw new Error("Apple sign-in failed: no identity token");
  return { idToken: cred.identityToken, rawNonce, fullName: cred.fullName };
}
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/mobile && npx jest src/lib/__tests__/socialAuth.test.ts --ci
```

Expected: all PASS.

- [ ] **Step 6: Prove the nonce test is load-bearing**

Temporarily change `signInAsync`'s `nonce: hashedNonce` to `nonce: rawNonce` and re-run. "sends the SHA-256 HASH to Apple" must FAIL. Restore.

- [ ] **Step 7: Configure `app.json`**

In `apps/mobile/app.json`, add `usesAppleSignIn` inside the existing `expo.ios` block (keep the existing `bundleIdentifier` and `entitlements` keys untouched — the HealthKit entitlement is #107's business, not this task's):

```json
    "ios": {
      "bundleIdentifier": "com.tesserix.kora",
      "usesAppleSignIn": true,
      "entitlements": {
        "com.apple.developer.healthkit": true,
        "com.apple.developer.healthkit.access": []
      }
    },
```

Append to the `expo.plugins` array:

```json
    "expo-apple-authentication",
    [
      "@react-native-google-signin/google-signin",
      {
        "iosUrlScheme": "REPLACE_WITH_REVERSED_IOS_CLIENT_ID"
      }
    ]
```

The `iosUrlScheme` value is the reversed iOS OAuth client id from the Firebase console (format `com.googleusercontent.apps.NNNNNNNN-xxxxx`). It comes from Step 9; return here and fill it in once the console work is done. **Do not commit the literal `REPLACE_WITH_REVERSED_IOS_CLIENT_ID`.**

- [ ] **Step 8: Add the environment variables**

Append to `apps/mobile/.env`:

```
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<web client id from Firebase console>
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<iOS client id from Firebase console>
```

Add the same two keys with placeholder values to `apps/mobile/.env.example`, and to the `env` block of all three profiles in `apps/mobile/eas.json` (`development`, `preview`, `production`).

- [ ] **Step 9: Console configuration (manual, outside the repo)**

These are prerequisites for device verification in Task 7 and cannot be done from the codebase:

1. Firebase console → `kora-app-e6d38` → Authentication → Sign-in method → enable **Google**. Copy the Web client ID and iOS client ID into `.env`.
2. Apple Developer → Certificates, Identifiers & Profiles → App ID `com.tesserix.kora` → enable **Sign in with Apple**.
3. Apple Developer → create a **Services ID** and a **Sign in with Apple key**; supply both to Firebase console → Authentication → Sign-in method → **Apple**.
4. Fill the real reversed iOS client id into `app.json`'s `iosUrlScheme`.

- [ ] **Step 10: Typecheck and full mobile suite**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
```

Expected: typecheck clean; suite count grows from 122 with no failures.

- [ ] **Step 11: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git status   # apps/mobile/eslint.config.js must NOT be staged; .env must NOT be staged
git add apps/mobile/src/lib/socialAuth.ts apps/mobile/src/lib/__tests__/socialAuth.test.ts \
        apps/mobile/app.json apps/mobile/eas.json apps/mobile/.env.example \
        apps/mobile/package.json apps/mobile/package-lock.json
git commit -m "feat(mobile): acquire Apple and Google credentials natively with a real nonce"
```

---

### Task 4: `socialCredentials.ts` — sign-in, conflict detection, name capture

**Files:**
- Create: `apps/mobile/src/auth/socialCredentials.ts`
- Modify: `apps/mobile/src/api/hooks.ts` (add `setDisplayName`)
- Test: `apps/mobile/src/auth/__tests__/socialCredentials.test.ts`

**Interfaces:**
- Consumes: `AppleFullName` from `@/lib/socialAuth` (Task 3); `PATCH /v1/me` from Task 1.
- Produces:
  - `type SocialSignInOutcome = { status: "signed-in" } | { status: "needs-link"; email: string; provider: "google.com" | "apple.com"; pendingCredential: AuthCredential }`
  - `signInWithGoogleCredential(idToken: string): Promise<SocialSignInOutcome>`
  - `signInWithAppleCredential(idToken: string, rawNonce: string, fullName?: AppleFullName | null): Promise<SocialSignInOutcome>`
  - `setDisplayName(name: string): Promise<unknown>` exported from `@/api/hooks`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/auth/__tests__/socialCredentials.test.ts`:

```ts
import { signInWithAppleCredential, signInWithGoogleCredential } from "@/auth/socialCredentials";

const mockSignInWithCredential = jest.fn();
const mockUpdateProfile = jest.fn(async () => {});
const appleCredential = { provider: "apple.com" };
const googleCredential = { provider: "google.com" };

jest.mock("firebase/auth", () => ({
  signInWithCredential: (...a: unknown[]) => mockSignInWithCredential(...a),
  updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
  GoogleAuthProvider: { credential: jest.fn(() => googleCredential) },
  OAuthProvider: jest.fn().mockImplementation(() => ({ credential: jest.fn(() => appleCredential) })),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

const mockSetDisplayName = jest.fn(async () => ({}));
jest.mock("@/api/hooks", () => ({ setDisplayName: (...a: unknown[]) => mockSetDisplayName(...a) }));

// A JWT whose payload is {"email":"sam@example.com"}.
const TOKEN_WITH_EMAIL =
  "aaa.eyJlbWFpbCI6InNhbUBleGFtcGxlLmNvbSJ9.bbb";

function conflict(extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("exists"), {
    code: "auth/account-exists-with-different-credential",
    ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithCredential.mockResolvedValue({ user: { displayName: null } });
});

describe("signInWithGoogleCredential", () => {
  it("reports signed-in on success", async () => {
    await expect(signInWithGoogleCredential("tok")).resolves.toEqual({ status: "signed-in" });
  });

  it("returns needs-link carrying the SAME credential the sign-in attempted", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict());
    const outcome = await signInWithGoogleCredential(TOKEN_WITH_EMAIL);
    expect(outcome.status).toBe("needs-link");
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.provider).toBe("google.com");
    // Identity, not shape: the prompt must link the credential that collided.
    expect(outcome.pendingCredential).toBe(googleCredential);
  });

  it("reads the email from the id_token payload", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict());
    const outcome = await signInWithGoogleCredential(TOKEN_WITH_EMAIL);
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.email).toBe("sam@example.com");
  });

  it("falls back to customData.email when the token is unparseable", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict({ customData: { email: "fb@example.com" } }));
    const outcome = await signInWithGoogleCredential("not-a-jwt");
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.email).toBe("fb@example.com");
  });

  it("propagates every other error rather than swallowing it into needs-link", async () => {
    const other = Object.assign(new Error("nope"), { code: "auth/network-request-failed" });
    mockSignInWithCredential.mockRejectedValue(other);
    await expect(signInWithGoogleCredential("tok")).rejects.toBe(other);
  });
});

describe("signInWithAppleCredential name capture", () => {
  it("persists a first-authorisation name to Firebase AND the server", async () => {
    await signInWithAppleCredential("tok", "nonce", { givenName: "Ada", familyName: "Lovelace" });
    expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), { displayName: "Ada Lovelace" });
    expect(mockSetDisplayName).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("writes Firebase BEFORE the server, so a failed PATCH still leaves the name recoverable", async () => {
    const order: string[] = [];
    mockUpdateProfile.mockImplementation(async () => { order.push("firebase"); });
    mockSetDisplayName.mockImplementation(async () => { order.push("server"); return {}; });
    await signInWithAppleCredential("tok", "nonce", { givenName: "Ada" });
    expect(order).toEqual(["firebase", "server"]);
  });

  it("stays signed in when the server write fails", async () => {
    mockSetDisplayName.mockRejectedValue(new Error("offline"));
    await expect(
      signInWithAppleCredential("tok", "nonce", { givenName: "Ada" }),
    ).resolves.toEqual({ status: "signed-in" });
  });

  it("does nothing when Apple returns no name", async () => {
    await signInWithAppleCredential("tok", "nonce", null);
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockSetDisplayName).not.toHaveBeenCalled();
  });

  it("does not overwrite a name the user already has", async () => {
    mockSignInWithCredential.mockResolvedValue({ user: { displayName: "Existing" } });
    await signInWithAppleCredential("tok", "nonce", { givenName: "Ada" });
    expect(mockSetDisplayName).not.toHaveBeenCalled();
  });

  it("skips a name that is only whitespace", async () => {
    await signInWithAppleCredential("tok", "nonce", { givenName: "  ", familyName: "  " });
    expect(mockSetDisplayName).not.toHaveBeenCalled();
  });

  it("returns needs-link with the Apple credential on a conflict", async () => {
    mockSignInWithCredential.mockRejectedValue(conflict());
    const outcome = await signInWithAppleCredential(TOKEN_WITH_EMAIL, "nonce", null);
    if (outcome.status !== "needs-link") throw new Error("unreachable");
    expect(outcome.provider).toBe("apple.com");
    expect(outcome.pendingCredential).toBe(appleCredential);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/mobile && npx jest src/auth/__tests__/socialCredentials.test.ts --ci
```

Expected: FAIL — cannot resolve `@/auth/socialCredentials`.

- [ ] **Step 3: Add the API client function**

Append to `apps/mobile/src/api/hooks.ts`, next to `useSetShareProgress`:

```ts
// Plain function, not a hook: it is called from the sign-in flow, outside any
// component that could hold a mutation.
export function setDisplayName(display_name: string): Promise<unknown> {
  return apiFetch("/v1/me", { method: "PATCH", body: JSON.stringify({ display_name }) });
}
```

- [ ] **Step 4: Implement `socialCredentials.ts`**

Create `apps/mobile/src/auth/socialCredentials.ts`:

```ts
import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  updateProfile,
  type AuthCredential,
  type UserCredential,
} from "firebase/auth";
import { toByteArray } from "base64-js";
import { auth } from "@/lib/firebase";
import { setDisplayName } from "@/api/hooks";
import type { AppleFullName } from "@/lib/socialAuth";

/**
 * `needs-link` means the project is one-account-per-email and an account
 * already exists for this email under a different provider — the caller must
 * have the user re-authenticate with their existing method, then link
 * `pendingCredential` onto it.
 */
export type SocialSignInOutcome =
  | { status: "signed-in" }
  | {
      status: "needs-link";
      email: string;
      provider: "google.com" | "apple.com";
      pendingCredential: AuthCredential;
    };

const ACCOUNT_EXISTS = "auth/account-exists-with-different-credential";

function isAccountExistsConflict(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { code?: unknown }).code === ACCOUNT_EXISTS
  );
}

/**
 * Best-effort read of the `email` claim from a provider id_token, used only to
 * decide which account the user must re-authenticate as. A UX hint, not a trust
 * decision — Firebase validates the signature server-side — so the payload is
 * decoded without verification. Returns "" for any malformed token.
 */
function emailFromIdToken(idToken: string): string {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const bytes = toByteArray(padded);
    const json = decodeURIComponent(
      Array.from(bytes)
        .map((b) => "%" + b.toString(16).padStart(2, "0"))
        .join(""),
    );
    const claims: unknown = JSON.parse(json);
    const email = (claims as { email?: unknown }).email;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

function needsLinkEmail(idToken: string, e: unknown): string {
  const fromToken = emailFromIdToken(idToken);
  if (fromToken) return fromToken;
  // JS SDK v9+ surfaces the conflicting email on customData (the native SDK
  // used userInfo — do not copy that shape here).
  const fromCustom = (e as { customData?: { email?: unknown } }).customData?.email;
  return typeof fromCustom === "string" ? fromCustom : "";
}

function requireAuth() {
  if (!auth) throw new Error("Firebase is not configured");
  return auth;
}

export async function signInWithGoogleCredential(idToken: string): Promise<SocialSignInOutcome> {
  const cred = GoogleAuthProvider.credential(idToken);
  try {
    await signInWithCredential(requireAuth(), cred);
    return { status: "signed-in" };
  } catch (e: unknown) {
    if (isAccountExistsConflict(e)) {
      return {
        status: "needs-link",
        email: needsLinkEmail(idToken, e),
        provider: "google.com",
        pendingCredential: cred,
      };
    }
    throw e;
  }
}

function buildDisplayName(fullName?: AppleFullName | null): string {
  if (!fullName) return "";
  return [fullName.givenName, fullName.familyName]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ");
}

export async function signInWithAppleCredential(
  idToken: string,
  rawNonce: string,
  fullName?: AppleFullName | null,
): Promise<SocialSignInOutcome> {
  const cred = new OAuthProvider("apple.com").credential({ idToken, rawNonce });
  let result: UserCredential;
  try {
    result = await signInWithCredential(requireAuth(), cred);
  } catch (e: unknown) {
    if (isAccountExistsConflict(e)) {
      return {
        status: "needs-link",
        email: needsLinkEmail(idToken, e),
        provider: "apple.com",
        pendingCredential: cred,
      };
    }
    throw e;
  }

  // Apple returns fullName ONLY on the first authorisation, ever. Firebase is
  // written first so that a failed server call still leaves the name somewhere
  // durable to re-sync from; neither failure may block sign-in.
  const displayName = buildDisplayName(fullName);
  if (displayName && !result.user.displayName) {
    try {
      await updateProfile(result.user, { displayName });
    } catch {
      // Non-fatal: the user stays signed in.
    }
    try {
      await setDisplayName(displayName);
    } catch {
      // Non-fatal: the name survives on the Firebase profile for a later re-sync.
    }
  }
  return { status: "signed-in" };
}
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/mobile && npx jest src/auth/__tests__/socialCredentials.test.ts --ci
```

Expected: all PASS.

- [ ] **Step 6: Prove the ordering test is load-bearing**

Temporarily swap the two `try` blocks so `setDisplayName` runs first. The "writes Firebase BEFORE the server" test must FAIL. Restore.

- [ ] **Step 7: Typecheck and commit**

```bash
cd apps/mobile && npx tsc --noEmit
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git status
git add apps/mobile/src/auth/socialCredentials.ts apps/mobile/src/auth/__tests__/socialCredentials.test.ts apps/mobile/src/api/hooks.ts
git commit -m "feat(mobile): exchange provider credentials for a Firebase session and capture the Apple name"
```

---

### Task 5: `link.ts` — the re-auth-then-link handshake

**Files:**
- Create: `apps/mobile/src/auth/link.ts`
- Test: `apps/mobile/src/auth/__tests__/link.test.ts`

**Interfaces:**
- Consumes: `auth` from `@/lib/firebase`.
- Produces:
  - `completeLinkWithPassword(email: string, password: string, pending: AuthCredential): Promise<void>`
  - `completeLinkWithGoogle(googleIdToken: string, pending: AuthCredential): Promise<void>`
  - `completeLinkWithApple(appleIdToken: string, rawNonce: string, pending: AuthCredential): Promise<void>`
  - `existingSignInMethods(email: string): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/auth/__tests__/link.test.ts`:

```ts
import {
  completeLinkWithApple,
  completeLinkWithGoogle,
  completeLinkWithPassword,
  existingSignInMethods,
} from "@/auth/link";

const mockSignInWithEmailAndPassword = jest.fn();
const mockSignInWithCredential = jest.fn();
const mockLinkWithCredential = jest.fn(async () => ({}));
const mockFetchSignInMethods = jest.fn();
const googleCredential = { provider: "google.com" };
const appleCredential = { provider: "apple.com" };

jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...a: unknown[]) => mockSignInWithEmailAndPassword(...a),
  signInWithCredential: (...a: unknown[]) => mockSignInWithCredential(...a),
  linkWithCredential: (...a: unknown[]) => mockLinkWithCredential(...a),
  fetchSignInMethodsForEmail: (...a: unknown[]) => mockFetchSignInMethods(...a),
  GoogleAuthProvider: { credential: jest.fn(() => googleCredential) },
  OAuthProvider: jest.fn().mockImplementation(() => ({ credential: jest.fn(() => appleCredential) })),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

const reauthedUser = { uid: "u1" };
const pending = { provider: "pending.example" } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithEmailAndPassword.mockResolvedValue({ user: reauthedUser });
  mockSignInWithCredential.mockResolvedValue({ user: reauthedUser });
});

describe("completeLinkWithPassword", () => {
  it("links the PENDING credential onto the RE-AUTHED user", async () => {
    await completeLinkWithPassword("sam@example.com", "pw", pending);
    // Both arguments pinned by identity: linking the wrong credential, or
    // linking onto the wrong user, is the failure this exists to prevent.
    expect(mockLinkWithCredential).toHaveBeenCalledWith(reauthedUser, pending);
  });

  it("re-authenticates before linking", async () => {
    const order: string[] = [];
    mockSignInWithEmailAndPassword.mockImplementation(async () => {
      order.push("reauth");
      return { user: reauthedUser };
    });
    mockLinkWithCredential.mockImplementation(async () => { order.push("link"); return {}; });
    await completeLinkWithPassword("sam@example.com", "pw", pending);
    expect(order).toEqual(["reauth", "link"]);
  });

  it("tags a re-auth failure so it is distinguishable from a link failure", async () => {
    // Firebase gives BOTH steps auth/invalid-credential. Only the tag separates
    // "wrong password" from "expired credential".
    mockSignInWithEmailAndPassword.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithPassword("sam@example.com", "bad", pending)).rejects.toMatchObject({
      code: "auth/reauth-failed",
    });
    expect(mockLinkWithCredential).not.toHaveBeenCalled();
  });

  it("leaves a LINK failure untagged, so it is not misreported as a bad password", async () => {
    mockLinkWithCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithPassword("sam@example.com", "pw", pending)).rejects.toMatchObject({
      code: "auth/invalid-credential",
    });
  });

  it("preserves the original error as `cause` on the tag", async () => {
    const original = { code: "auth/too-many-requests" };
    mockSignInWithEmailAndPassword.mockRejectedValue(original);
    await expect(completeLinkWithPassword("s@e.com", "pw", pending)).rejects.toMatchObject({
      cause: original,
    });
  });
});

describe("completeLinkWithGoogle", () => {
  it("re-auths with the Google credential then links the pending one", async () => {
    await completeLinkWithGoogle("g-token", pending);
    expect(mockSignInWithCredential).toHaveBeenCalledWith(expect.anything(), googleCredential);
    expect(mockLinkWithCredential).toHaveBeenCalledWith(reauthedUser, pending);
  });

  it("tags a failed Google re-auth", async () => {
    mockSignInWithCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithGoogle("g-token", pending)).rejects.toMatchObject({
      code: "auth/reauth-failed",
    });
  });
});

describe("completeLinkWithApple", () => {
  it("re-auths with the Apple credential then links the pending one", async () => {
    await completeLinkWithApple("a-token", "nonce", pending);
    expect(mockSignInWithCredential).toHaveBeenCalledWith(expect.anything(), appleCredential);
    expect(mockLinkWithCredential).toHaveBeenCalledWith(reauthedUser, pending);
  });

  it("tags a failed Apple re-auth", async () => {
    mockSignInWithCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    await expect(completeLinkWithApple("a-token", "nonce", pending)).rejects.toMatchObject({
      code: "auth/reauth-failed",
    });
  });
});

describe("existingSignInMethods", () => {
  it("returns what Firebase reports", async () => {
    mockFetchSignInMethods.mockResolvedValue(["password", "google.com"]);
    await expect(existingSignInMethods("sam@example.com")).resolves.toEqual([
      "password",
      "google.com",
    ]);
  });

  it("returns [] rather than throwing when the lookup fails", async () => {
    mockFetchSignInMethods.mockRejectedValue(new Error("enumeration protection"));
    await expect(existingSignInMethods("sam@example.com")).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/mobile && npx jest src/auth/__tests__/link.test.ts --ci
```

Expected: FAIL — cannot resolve `@/auth/link`.

- [ ] **Step 3: Implement `link.ts`**

Create `apps/mobile/src/auth/link.ts`:

```ts
// Completes the one-account-per-email merge: the user re-authenticates with the
// method their account already has, then the pending provider credential is
// linked onto that account.

import {
  GoogleAuthProvider,
  OAuthProvider,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  signInWithCredential,
  signInWithEmailAndPassword,
  type AuthCredential,
  type UserCredential,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

function requireAuth() {
  if (!auth) throw new Error("Firebase is not configured");
  return auth;
}

/**
 * Tags a failure of the RE-AUTH step. Firebase gives both the re-auth and the
 * link step `auth/invalid-credential` — "wrong password" in one, "expired
 * credential" in the other. Tagging by which call threw is the only way to tell
 * them apart; never branch on the code.
 */
function reauthFailed(cause: unknown): Error {
  return Object.assign(new Error("Re-authentication failed"), {
    code: "auth/reauth-failed",
    cause,
  });
}

/** Re-auth with the account's existing password, then attach `pending`. */
export async function completeLinkWithPassword(
  email: string,
  password: string,
  pending: AuthCredential,
): Promise<void> {
  let result: UserCredential;
  try {
    result = await signInWithEmailAndPassword(requireAuth(), email, password);
  } catch (e: unknown) {
    throw reauthFailed(e);
  }
  await linkWithCredential(result.user, pending);
}

/** Re-auth with the account's existing Google identity, then attach `pending`. */
export async function completeLinkWithGoogle(
  googleIdToken: string,
  pending: AuthCredential,
): Promise<void> {
  const existing = GoogleAuthProvider.credential(googleIdToken);
  let result: UserCredential;
  try {
    result = await signInWithCredential(requireAuth(), existing);
  } catch (e: unknown) {
    throw reauthFailed(e);
  }
  await linkWithCredential(result.user, pending);
}

/** Re-auth with the account's existing Apple identity, then attach `pending`. */
export async function completeLinkWithApple(
  appleIdToken: string,
  rawNonce: string,
  pending: AuthCredential,
): Promise<void> {
  const existing = new OAuthProvider("apple.com").credential({ idToken: appleIdToken, rawNonce });
  let result: UserCredential;
  try {
    result = await signInWithCredential(requireAuth(), existing);
  } catch (e: unknown) {
    throw reauthFailed(e);
  }
  await linkWithCredential(result.user, pending);
}

/**
 * Sign-in methods already registered for `email` — e.g. ["password"],
 * ["google.com"]. Returns [] when email-enumeration protection is on, in which
 * case the caller must ask the user which method they used. Never throws: a
 * hint that cannot be fetched must not break the prompt.
 */
export async function existingSignInMethods(email: string): Promise<string[]> {
  try {
    return await fetchSignInMethodsForEmail(requireAuth(), email);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/mobile && npx jest src/auth/__tests__/link.test.ts --ci
```

Expected: all PASS.

- [ ] **Step 5: Prove the tag tests are load-bearing**

Temporarily remove the `try`/`catch` around `signInWithEmailAndPassword` (let the raw error propagate). The "tags a re-auth failure" test must FAIL. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/mobile && npx tsc --noEmit
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git status
git add apps/mobile/src/auth/link.ts apps/mobile/src/auth/__tests__/link.test.ts
git commit -m "feat(mobile): link a second auth provider after re-authentication"
```

---

### Task 6: `LinkAccountPrompt` component

**Files:**
- Create: `apps/mobile/src/components/auth/LinkAccountPrompt.tsx`
- Test: `apps/mobile/src/components/auth/__tests__/LinkAccountPrompt.test.tsx`

**Interfaces:**
- Consumes: `existingSignInMethods`, `completeLinkWith*` (Task 5); `signInWithGoogleNative`, `signInWithAppleNative`, `configureGoogleSignin` (Task 3); `firebaseAuthMessage`, `AuthErrorContext` (Task 2).
- Produces: `<LinkAccountPrompt visible email provider pendingCredential onCancel onLinked />`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/components/auth/__tests__/LinkAccountPrompt.test.tsx`:

```tsx
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { LinkAccountPrompt } from "@/components/auth/LinkAccountPrompt";

const mockExistingSignInMethods = jest.fn();
const mockCompleteLinkWithPassword = jest.fn(async () => {});
const mockCompleteLinkWithGoogle = jest.fn(async () => {});
jest.mock("@/auth/link", () => ({
  existingSignInMethods: (...a: unknown[]) => mockExistingSignInMethods(...a),
  completeLinkWithPassword: (...a: unknown[]) => mockCompleteLinkWithPassword(...a),
  completeLinkWithGoogle: (...a: unknown[]) => mockCompleteLinkWithGoogle(...a),
  completeLinkWithApple: jest.fn(async () => {}),
}));
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(async () => "g-token"),
  signInWithAppleNative: jest.fn(async () => ({ idToken: "a", rawNonce: "n", fullName: null })),
}));

const pending = { provider: "apple.com" } as never;

function renderPrompt(overrides: Record<string, unknown> = {}) {
  const onLinked = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <LinkAccountPrompt
      visible
      email="sam@example.com"
      provider="apple.com"
      pendingCredential={pending}
      onCancel={onCancel}
      onLinked={onLinked}
      {...overrides}
    />,
  );
  return { ...utils, onLinked, onCancel };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExistingSignInMethods.mockResolvedValue(["password"]);
});

describe("LinkAccountPrompt", () => {
  it("names the account being linked", async () => {
    const { findByText } = renderPrompt();
    expect(await findByText(/sam@example.com/)).toBeTruthy();
  });

  it("offers only the password control when that is the registered method", async () => {
    const { findByLabelText, queryByLabelText } = renderPrompt();
    expect(await findByLabelText("Sign in and link")).toBeTruthy();
    expect(queryByLabelText("Continue with Google to link")).toBeNull();
  });

  // Enumeration protection makes the lookup return []. Failing CLOSED here would
  // leave the sheet with nothing but Cancel — an unrecoverable dead end.
  it("fails open and offers every other method when the lookup returns nothing", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { findByLabelText } = renderPrompt();
    expect(await findByLabelText("Sign in and link")).toBeTruthy();
    expect(await findByLabelText("Continue with Google to link")).toBeTruthy();
  });

  it("never offers the provider currently being linked as its own re-auth method", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { queryByLabelText, findByLabelText } = renderPrompt({ provider: "google.com" });
    await findByLabelText("Sign in and link");
    expect(queryByLabelText("Continue with Google to link")).toBeNull();
  });

  it("links with the pending credential and reports success", async () => {
    const { findByLabelText, getByLabelText, onLinked } = renderPrompt();
    fireEvent.changeText(getByLabelText("Password"), "hunter2");
    fireEvent.press(await findByLabelText("Sign in and link"));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mockCompleteLinkWithPassword).toHaveBeenCalledWith("sam@example.com", "hunter2", pending);
  });

  it("shows mapped copy on failure and does not report success", async () => {
    mockCompleteLinkWithPassword.mockRejectedValue({ code: "auth/reauth-failed" });
    const { findByLabelText, findByText, onLinked } = renderPrompt();
    fireEvent.press(await findByLabelText("Sign in and link"));
    expect(await findByText("That password is incorrect.")).toBeTruthy();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("never leaks a raw SDK message", async () => {
    mockCompleteLinkWithPassword.mockRejectedValue({
      code: "auth/unknown",
      message: "/Users/x/Native.swift:42 boom",
    });
    const { findByLabelText, queryByText, findByText } = renderPrompt();
    fireEvent.press(await findByLabelText("Sign in and link"));
    await findByText("Something went wrong. Please try again.");
    expect(queryByText(/Native.swift/)).toBeNull();
  });

  // Absence assertion made meaningful: an error is on screen FIRST, so a
  // component that never clears errors fails here.
  it("clears the error when a cancelled sign-in follows a failure", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    mockCompleteLinkWithPassword.mockRejectedValue({ code: "auth/reauth-failed" });
    const { findByLabelText, findByText, queryByText } = renderPrompt();
    fireEvent.press(await findByLabelText("Sign in and link"));
    expect(await findByText("That password is incorrect.")).toBeTruthy();

    const { AuthCancelledError } = jest.requireActual("@/auth/errors");
    mockCompleteLinkWithGoogle.mockRejectedValue(new AuthCancelledError());
    fireEvent.press(await findByLabelText("Continue with Google to link"));
    await waitFor(() => expect(queryByText("That password is incorrect.")).toBeNull());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/mobile && npx jest src/components/auth --ci
```

Expected: FAIL — cannot resolve `@/components/auth/LinkAccountPrompt`.

- [ ] **Step 3: Implement the component**

Create `apps/mobile/src/components/auth/LinkAccountPrompt.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Modal, TextInput, View } from "react-native";
import type { AuthCredential } from "firebase/auth";
import {
  completeLinkWithApple,
  completeLinkWithGoogle,
  completeLinkWithPassword,
  existingSignInMethods,
} from "@/auth/link";
import type { AuthErrorContext } from "@/auth/errors";
import { firebaseAuthMessage } from "@/lib/firebaseAuthMessage";
import {
  configureGoogleSignin,
  signInWithAppleNative,
  signInWithGoogleNative,
} from "@/lib/socialAuth";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

export interface LinkAccountPromptProps {
  visible: boolean;
  email: string;
  provider: "google.com" | "apple.com";
  pendingCredential: AuthCredential;
  onCancel: () => void;
  onLinked: () => void;
}

const PROVIDER_LABEL: Record<LinkAccountPromptProps["provider"], string> = {
  "google.com": "Google",
  "apple.com": "Apple",
};

export function LinkAccountPrompt({
  visible,
  email,
  provider,
  pendingCredential,
  onCancel,
  onLinked,
}: LinkAccountPromptProps) {
  const { colors, spacing, fontSize } = useTheme();
  const [methods, setMethods] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await existingSignInMethods(email);
      if (!cancelled) setMethods(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  const passwordMatches = methods?.includes("password") ?? false;
  const googleMatches = methods?.includes("google.com") ?? false;
  const appleMatches = methods?.includes("apple.com") ?? false;
  // `unknown` covers every case where nothing above would render a control:
  // enumeration protection ([]), an unrecognised method list, and the case where
  // the only match is the provider being linked (which can never be its own
  // re-auth option). Fail OPEN in all of them, so the sheet never dead-ends
  // with just Cancel.
  const anyControlWouldRender =
    passwordMatches ||
    (provider !== "google.com" && googleMatches) ||
    (provider !== "apple.com" && appleMatches);
  const unknown = methods !== null && !anyControlWouldRender;
  const showPassword = methods === null || unknown || passwordMatches;
  const showGoogle = provider !== "google.com" && (unknown || googleMatches);
  const showApple = provider !== "apple.com" && (unknown || appleMatches);

  async function run(fn: () => Promise<void>, ctx?: AuthErrorContext) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await fn();
      onLinked();
    } catch (e: unknown) {
      // null means the user cancelled — render nothing.
      setError(firebaseAuthMessage(e, ctx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        <Card variant="elevated" style={{ padding: spacing.lg, gap: spacing.sm }}>
          <AppText variant="title2">Link your account</AppText>
          <AppText muted>
            An account already exists for {email}. Sign in to connect {PROVIDER_LABEL[provider]}.
          </AppText>

          {showPassword ? (
            <View style={{ gap: spacing.sm }}>
              <Card variant="elevated" style={{ padding: 0 }}>
                <TextInput
                  accessibilityLabel="Password"
                  style={{
                    paddingHorizontal: spacing.md,
                    paddingVertical: 12,
                    color: colors.label,
                    fontSize: fontSize.base,
                    minHeight: 48,
                  }}
                  placeholder="Password"
                  placeholderTextColor={colors.secondaryLabel}
                  secureTextEntry
                  autoComplete="password"
                  textContentType="password"
                  value={password}
                  onChangeText={setPassword}
                />
              </Card>
              <Button
                accessibilityLabel="Sign in and link"
                title={busy ? "Linking…" : "Sign in and link"}
                disabled={busy}
                onPress={() =>
                  void run(() => completeLinkWithPassword(email, password, pendingCredential), {
                    method: "password",
                  })
                }
              />
            </View>
          ) : null}

          {showGoogle ? (
            <Button
              accessibilityLabel="Continue with Google to link"
              title="Continue with Google to link"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void run(
                  async () => {
                    configureGoogleSignin();
                    const idToken = await signInWithGoogleNative();
                    await completeLinkWithGoogle(idToken, pendingCredential);
                  },
                  { method: "social", provider: "google.com" },
                )
              }
            />
          ) : null}

          {showApple ? (
            <Button
              accessibilityLabel="Continue with Apple to link"
              title="Continue with Apple to link"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void run(
                  async () => {
                    const { idToken, rawNonce } = await signInWithAppleNative();
                    await completeLinkWithApple(idToken, rawNonce, pendingCredential);
                  },
                  { method: "social", provider: "apple.com" },
                )
              }
            />
          ) : null}

          {error ? (
            <AppText
              variant="footnote"
              accessibilityLiveRegion="polite"
              style={{ color: colors.destructive }}
            >
              {error}
            </AppText>
          ) : null}

          <Button accessibilityLabel="Cancel" title="Cancel" variant="ghost" disabled={busy} onPress={onCancel} />
        </Card>
      </View>
    </Modal>
  );
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/mobile && npx jest src/components/auth --ci
```

Expected: all PASS. If `AppText` has no `title3` variant or `Card` has no `elevated` variant, read `src/components/Text.tsx` and `src/components/Card.tsx` and substitute the nearest existing one — do not add new variants.

- [ ] **Step 5: Prove the fail-open test is load-bearing**

Temporarily set `const unknown = false;`. The "fails open and offers every other method" test must FAIL. Restore.

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/mobile && npx tsc --noEmit
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git status
git add apps/mobile/src/components/auth/
git commit -m "feat(mobile): add the link-account prompt for a second sign-in provider"
```

---

### Task 7: Wire the providers into the sign-in screen, then verify on device

**Files:**
- Modify: `apps/mobile/app/sign-in.tsx`
- Test: `apps/mobile/app/__tests__/sign-in-social.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2-6.
- Produces: the shipped sign-in screen.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/app/__tests__/sign-in-social.test.tsx`:

```tsx
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import SignIn from "../sign-in";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: jest.fn(async () => ({})),
  createUserWithEmailAndPassword: jest.fn(async () => ({})),
}));

const mockSignInWithAppleCredential = jest.fn();
const mockSignInWithGoogleCredential = jest.fn();
jest.mock("@/auth/socialCredentials", () => ({
  signInWithAppleCredential: (...a: unknown[]) => mockSignInWithAppleCredential(...a),
  signInWithGoogleCredential: (...a: unknown[]) => mockSignInWithGoogleCredential(...a),
}));
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(async () => "g-token"),
  signInWithAppleNative: jest.fn(async () => ({
    idToken: "a-token",
    rawNonce: "raw",
    fullName: { givenName: "Ada" },
  })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithAppleCredential.mockResolvedValue({ status: "signed-in" });
  mockSignInWithGoogleCredential.mockResolvedValue({ status: "signed-in" });
});

describe("sign-in social providers", () => {
  it("offers both providers", () => {
    const { getByLabelText } = render(<SignIn />);
    expect(getByLabelText("Continue with Apple")).toBeTruthy();
    expect(getByLabelText("Continue with Google")).toBeTruthy();
  });

  it("passes the RAW nonce and token from the native sheet through to Firebase", async () => {
    const { getByLabelText } = render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Apple"));
    await waitFor(() =>
      expect(mockSignInWithAppleCredential).toHaveBeenCalledWith("a-token", "raw", {
        givenName: "Ada",
      }),
    );
  });

  it("navigates to the app on a successful Apple sign-in", async () => {
    const { getByLabelText } = render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Apple"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("navigates to the app on a successful Google sign-in", async () => {
    const { getByLabelText } = render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Google"));
    await waitFor(() => expect(mockSignInWithGoogleCredential).toHaveBeenCalledWith("g-token"));
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("opens the link prompt on a conflict instead of navigating", async () => {
    mockSignInWithAppleCredential.mockResolvedValue({
      status: "needs-link",
      email: "sam@example.com",
      provider: "apple.com",
      pendingCredential: {},
    });
    const { getByLabelText, findByText } = render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Apple"));
    expect(await findByText(/Link your account/)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows mapped copy when a provider sign-in fails", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText } = render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Google"));
    expect(await findByText("Couldn't reach Kora. Check your connection.")).toBeTruthy();
  });

  // Absence made meaningful: an error is on screen first.
  it("shows nothing when the user cancels the native sheet", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText, queryByText } = render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Google"));
    await findByText("Couldn't reach Kora. Check your connection.");

    const { AuthCancelledError } = jest.requireActual("@/auth/errors");
    mockSignInWithGoogleCredential.mockRejectedValue(new AuthCancelledError());
    fireEvent.press(getByLabelText("Continue with Google"));
    await waitFor(() =>
      expect(queryByText("Couldn't reach Kora. Check your connection.")).toBeNull(),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/mobile && npx jest app/__tests__/sign-in-social.test.tsx --ci
```

Expected: FAIL — no "Continue with Apple" label.

- [ ] **Step 3: Modify `app/sign-in.tsx`**

Add to the imports:

```tsx
import { Platform } from "react-native";
import { signInWithAppleCredential, signInWithGoogleCredential } from "@/auth/socialCredentials";
import {
  configureGoogleSignin,
  signInWithAppleNative,
  signInWithGoogleNative,
} from "@/lib/socialAuth";
import { LinkAccountPrompt } from "@/components/auth/LinkAccountPrompt";
import type { SocialSignInOutcome } from "@/auth/socialCredentials";
import type { AuthCredential } from "firebase/auth";
```

Add state next to the existing `busy` state:

```tsx
  const [pendingLink, setPendingLink] = useState<
    Extract<SocialSignInOutcome, { status: "needs-link" }> | null
  >(null);
```

Add the shared runner and the two handlers after `submit`:

```tsx
  async function runSocial(fn: () => Promise<SocialSignInOutcome>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await fn();
      if (outcome.status === "needs-link") {
        setPendingLink(outcome);
        return;
      }
      router.replace("/");
    } catch (e: unknown) {
      // null means cancelled — clears any stale error and shows nothing new.
      setError(firebaseAuthMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function signInApple() {
    void runSocial(async () => {
      const { idToken, rawNonce, fullName } = await signInWithAppleNative();
      return signInWithAppleCredential(idToken, rawNonce, fullName);
    });
  }

  function signInGoogle() {
    void runSocial(async () => {
      configureGoogleSignin();
      return signInWithGoogleCredential(await signInWithGoogleNative());
    });
  }
```

Render the buttons immediately after `<BrandLockup />`'s sibling copy and before the `<Segmented .../>` block:

```tsx
        <View style={{ gap: spacing.sm }}>
          {Platform.OS === "ios" ? (
            <Button
              accessibilityLabel="Continue with Apple"
              title="Continue with Apple"
              disabled={busy}
              onPress={signInApple}
            />
          ) : null}
          <Button
            accessibilityLabel="Continue with Google"
            title="Continue with Google"
            variant="secondary"
            disabled={busy}
            onPress={signInGoogle}
          />
        </View>
```

Render the prompt as the last child inside `<AuthScaffold>`:

```tsx
        {pendingLink ? (
          <LinkAccountPrompt
            visible
            email={pendingLink.email}
            provider={pendingLink.provider}
            pendingCredential={pendingLink.pendingCredential as AuthCredential}
            onCancel={() => setPendingLink(null)}
            onLinked={() => {
              setPendingLink(null);
              router.replace("/");
            }}
          />
        ) : null}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/mobile && npx jest app/__tests__/sign-in-social.test.tsx --ci
```

Expected: all PASS. The Apple tests rely on `Platform.OS === "ios"`, which `jest-expo` defaults to; if the preset resolves to another platform, add `jest.mock("react-native/Libraries/Utilities/Platform", () => ({ OS: "ios", select: (o: Record<string, unknown>) => o.ios }))` to the test file.

- [ ] **Step 5: Prove the conflict test is load-bearing**

Temporarily delete the `if (outcome.status === "needs-link")` branch. "opens the link prompt on a conflict" must FAIL. Restore.

- [ ] **Step 6: Full suite and typecheck**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
cd ../../api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 ./...
```

Expected: both green; mobile suite count above 122 with 0 failures.

- [ ] **Step 7: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git status
git add apps/mobile/app/sign-in.tsx apps/mobile/app/__tests__/sign-in-social.test.tsx
git commit -m "feat(mobile): offer Apple and Google sign-in on the sign-in screen"
```

- [ ] **Step 8: Device verification — REQUIRED, and the suite does not substitute**

Both providers are native modules. Green tests say nothing about whether the build is signed and configured correctly. Build a **Release** configuration so the JS bundle is embedded, pointed at prod:

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo run:ios --device --configuration Release
```

Confirm each, on a physical device:

1. Fresh install signs in with **Apple** and reaches the diary.
2. Fresh install signs in with **Google** and reaches the diary.
3. An Apple sign-in with **Hide My Email** completes and can log a meal.
4. A first-authorisation Apple sign-in populates `users.display_name` — verified by query, not by the UI:

```bash
kubectl -n global exec global-postgres-1 -c postgres -- psql -U postgres -d kora_db \
  -c "SELECT email, display_name FROM users ORDER BY created_at DESC LIMIT 3;"
```

5. Signing in with the second provider on an email that already has an account reaches `LinkAccountPrompt`, links, and both buttons work afterwards.
6. Cancelling each native sheet shows **no** error message.

- [ ] **Step 9: Open the PR**

Write the PR body to the session scratchpad first — it must record the
device-verification results from Step 8 explicitly, naming which of the six
checks were run and on which device. Do not claim verification that was not
performed; if a check was skipped, say so and say why.

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git push -u origin feat/social-login-108
gh pr create --title "feat: social login — Sign in with Apple + Google (#108)" \
  --body-file "$SCRATCHPAD/social-login-pr.md"
```

Where `$SCRATCHPAD` is this session's scratchpad directory. PRs in this repo are
merge-committed, not squashed.

---

## Notes for the reviewer

- Task 1 is the only server change, and it exists because `users.display_name` is read in five places and written nowhere. Prod confirms it: 5 users, 0 named.
- The nonce in Task 3 deliberately diverges from mark8ly, whose `rawNonce: ""` is justified by GIP behaviour that does not apply to a plain Firebase project.
- `needsLinkEmail` in Task 4 reads `customData.email` (JS SDK), **not** `userInfo.email` (native SDK). Copying mark8ly's shape here would silently yield an empty email and a prompt that cannot name the account.
- Every task has a "prove the test is load-bearing" step. Treat a mutation that survives as a finding, not a row to pass over — and before calling it an environment limitation, check the mutation actually targets the path the test exercises.
