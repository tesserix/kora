# Kora identity: handles and profile pictures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Kora user an optional handle they can say out loud and an optional profile picture, so exact-match lookup replaces reading an opaque friend code aloud.

**Architecture:** A new `internal/identity` package owns handle canonicalisation (pure, table-driven) and the DB-backed claim/retire/lookup service. Image normalisation moves out of `internal/bodyread` into a shared `internal/imageproc` package and gains an avatar path; objects land in a new `internal/assets` store with a GCS implementation for deploy and a filesystem implementation for local dev. A new `internal/ratelimit` fixed-window middleware guards lookup. Mobile gains a handle-first `AddFriendSheet`, a lookup result card, and profile editing for both fields.

**Tech Stack:** Go 1.26 · Gin · GORM · PostgreSQL · `cloud.google.com/go/storage` (already an indirect dep) · Expo SDK 57 / React Native · TanStack Query · `expo-image-picker` (already a dep)

**Spec:** `docs/superpowers/specs/2026-08-25-identity-handle-and-avatar-design.md` (on PR #450, branch `docs/identity-spec`). Issue: kora#449.

---

## Premise corrections — read before Task 6

Every premise in the spec was checked against the code on 2026-08-25. All held
except one, and it changes the work:

- **FALSE — "`golang.org/x/image/draw` is a genuine new dependency" and
  "`downscale.go` uses nearest-neighbour".** kora#365 already replaced
  nearest-neighbour with `boxAverageResize` in
  `api/internal/bodyread/downscale.go` — edge-derived box averaging where every
  source pixel contributes to exactly one destination pixel. Its own comment
  says the nearest-neighbour justification "had the reasoning backwards".
  Box averaging *is* area resampling, the correct filter for a large downscale
  of a photograph; it does not alias a face. **Do not add x/image.** The file's
  package doc comment at the top still describes nearest-neighbour and still
  says x/image "would need to be added as a new dependency then" — that comment
  is stale and is what the spec and the issue were both written from. Task 6
  deletes it.
- TRUE — no rate limiting exists anywhere in the API. `internal/guardrails` is
  a pure nudge-policy function (`Evaluate(Nudge, Signals) Decision`), not a
  limiter. `internal/billing.Meter` is a per-user monthly *cost* cap, a
  different thing on a different axis.
- TRUE — Kora persists no user images. Zero files import
  `cloud.google.com/go/storage`. It is nonetheless already in `go.mod` as an
  **indirect** dependency (v1.62.1, via `firebase.google.com/go/v4`), so Task 7
  promotes an existing module rather than adding a new one.
- TRUE — the decode-bomb guard exists as `declaredPixelsExceedCap`, already
  extracted as its own function precisely so it can be exercised directly. It
  is unexported in package `bodyread`; Task 6 moves it rather than copying it.
- TRUE — `user.Service.Delete` is the single 18-table cascade, and it already
  loads the user row up front because two later steps need columns that stop
  existing after the DELETE. `avatar_path` is a third such column.
- TRUE — `social.FriendView` and `share.MemberView` never project email.
- Latest migration is `000055_drop_share_progress`; the new one is `000056`.

**Two facts the spec does not state, established here:**

- **`kora-api` runs a single replica** (`kubectl get deploy -n kora kora-api` →
  `1/1`). An in-process fixed-window limiter is therefore exact today. This
  matters because Redis in this API is *optional* — `cmd/api/main.go` falls back
  to `ai.NoCache{}` when `REDIS_URL` fails to parse, so a Redis-backed limiter
  would fail **open**, silently, which is the one failure mode a limiter
  described as "the only thing standing between exact-match lookup and offline
  enumeration" cannot have. Task 4 is in-process for that reason, and says so in
  a comment so a future reader does not "improve" it into Redis without
  re-deciding.
- **`apiFetchMultipart` hardcodes `method: "POST"`**
  (`apps/mobile/src/lib/api.ts:480`). The spec's `PUT /v1/me/avatar` needs a
  method parameter; Task 11 adds one, defaulted to POST so no existing caller
  changes.

## Global Constraints

- **The repo is PUBLIC.** Never put a real weight, measurement or intake value
  in a commit, comment, test fixture, issue or PR. Describe results as counts.
- Go module root is `api/`. Run every Go command from there.
- DB tests read `TEST_DATABASE_URL`, defaulting to
  `postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable`, and `t.Skipf`
  when Postgres is unavailable. Run them with `-p 1` — they share one database.
- `localhost:5432` is the **native Homebrew** postgres (what `api/.env` points
  at), not Docker's. For manual queries use
  `/opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -U kora -d kora`.
- Handles are **exact-match only**. No prefix search, no listing, no directory
  endpoint — not even an admin one.
- Confusables fold for uniqueness **and** for lookup.
- Retired handles never return to the pool.
- Reserved handles: `kora`, `admin`, `support`, `help`, `team`.
- Handle shape: 3–20 characters, `[a-z0-9_]` after canonicalisation.
- Avatar: 8 MiB request cap, 512×512 max, re-encoded to JPEG.
- Lookup returns **404 for a miss and never an email**.
- Every response goes through `httpx.OK` / `httpx.Error`; no bare `c.JSON`.
- Commit messages are single-line, conventional-commit prefixed, no signature.

## File Structure

**API — new**

| File | Responsibility |
|---|---|
| `api/internal/identity/handle.go` | Pure canonicalisation: trim, case, charset, length, reserved, confusable fold. No DB. |
| `api/internal/identity/errors.go` | `ErrHandleInvalid`, `ErrHandleReserved`, `ErrHandleTaken`, `ErrHandleRetired`, `ErrNotFound`. |
| `api/internal/identity/repository.go` | GORM access to `users.handle*` and `retired_handles`. |
| `api/internal/identity/service.go` | Claim / clear / lookup, retirement on change. |
| `api/internal/identity/handler.go` | `PUT`/`DELETE /v1/me/handle`, `GET /v1/users/lookup`. |
| `api/internal/identity/model.go` | `LookupView` — the projection that must never carry an email. |
| `api/internal/identity/avatar_handler.go` | `PUT`/`DELETE /v1/me/avatar` (multipart). |
| `api/internal/ratelimit/window.go` | In-process fixed-window counter. |
| `api/internal/ratelimit/middleware.go` | Gin middleware keyed on the authenticated user. |
| `api/internal/imageproc/decode.go` | `DeclaredPixelsExceedCap`, `MaxDecodePixels` — moved from `bodyread`. |
| `api/internal/imageproc/resize.go` | `BoxAverageResize` — moved from `bodyread`. |
| `api/internal/imageproc/avatar.go` | `NormalizeAvatar([]byte) ([]byte, error)` — cap, decode, square-crop, 512, JPEG. |
| `api/internal/assets/store.go` | `Store` interface: `Put`, `Delete`, `URL`. |
| `api/internal/assets/gcs.go` | GCS implementation. |
| `api/internal/assets/local.go` | Filesystem implementation for local dev and tests. |
| `api/internal/database/migrations/000056_identity_handles_avatars.{up,down}.sql` | Schema. |

**API — modified**

| File | Change |
|---|---|
| `api/internal/bodyread/downscale.go` | Delete the stale package doc comment; call `imageproc` instead of local copies. |
| `api/internal/user/model.go` | `Handle`, `HandleCanonical`, `AvatarPath` fields. |
| `api/internal/user/deletion.go` | Delete the avatar object as a cascade step. |
| `api/internal/social/model.go` | `FriendView` gains `Handle`, `AvatarURL`. |
| `api/internal/share/model.go` | `MemberView` gains `AvatarURL`. |
| `api/internal/config/config.go` | `AssetsBucket`, `AssetsPublicBaseURL`, `AssetsLocalDir`. |
| `api/internal/server/router.go` | Wire identity, ratelimit, assets. |
| `api/cmd/api/main.go` | Construct the assets store. |

**Mobile — modified**

| File | Change |
|---|---|
| `apps/mobile/src/components/Avatar.tsx` | Optional `uri` renders an image; initials remain the fallback. |
| `apps/mobile/src/lib/api.ts` | `apiFetchMultipart` gains a `method` option. |
| `apps/mobile/src/api/types.ts` | `LookupResult`, `MyHandle`. |
| `apps/mobile/src/api/hooks.ts` | `useLookupHandle`, `useSetHandle`, `useClearHandle`, `useUploadAvatar`, `useDeleteAvatar`. |
| `apps/mobile/src/components/social/AddFriendSheet.tsx` | Handle becomes the primary field; lookup result card. |
| `apps/mobile/app/profile.tsx` | Handle and picture, both editable, both removable. |

---

## Phase A — the handle (API)

### Task 1: Handle canonicalisation

Pure functions, no database. This is where every rule about what a handle *is*
lives, so the DB-backed tasks that follow have nothing to re-decide.

**Files:**
- Create: `api/internal/identity/handle.go`
- Create: `api/internal/identity/errors.go`
- Test: `api/internal/identity/handle_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `func Canonical(raw string) (display string, canonical string, err error)` —
    `display` is the trimmed, lowercased form stored for display; `canonical` is
    that with confusables folded, and is what the unique index and every lookup
    use. Returns `ErrHandleInvalid` or `ErrHandleReserved`.
  - `var ErrHandleInvalid, ErrHandleReserved, ErrHandleTaken, ErrHandleRetired, ErrNotFound error`
  - `const MinHandleLen = 3`, `const MaxHandleLen = 20`

- [ ] **Step 1: Write the failing test**

Create `api/internal/identity/handle_test.go`:

```go
package identity

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCanonical(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		display   string
		canonical string
		err       error
	}{
		{name: "plain", raw: "ada", display: "ada", canonical: "ada"},
		{name: "uppercase folds to lower", raw: "AdaL", display: "adal", canonical: "ada1"},
		{name: "surrounding space is trimmed", raw: "  ada  ", display: "ada", canonical: "ada"},
		{name: "leading at sign is accepted and dropped", raw: "@ada", display: "ada", canonical: "ada"},
		{name: "underscore is allowed", raw: "ada_lovelace", display: "ada_lovelace", canonical: "ada_10ve1ace"},
		{name: "digits are allowed", raw: "ada2026", display: "ada2026", canonical: "ada2026"},
		{name: "too short", raw: "ad", err: ErrHandleInvalid},
		{name: "too long", raw: "abcdefghijklmnopqrstu", err: ErrHandleInvalid},
		{name: "empty", raw: "", err: ErrHandleInvalid},
		{name: "space inside", raw: "ada lovelace", err: ErrHandleInvalid},
		{name: "hyphen is not in the charset", raw: "ada-l", err: ErrHandleInvalid},
		{name: "dot is not in the charset", raw: "ada.l", err: ErrHandleInvalid},
		{name: "non-ascii is not in the charset", raw: "adaé", err: ErrHandleInvalid},
		{name: "reserved", raw: "support", err: ErrHandleReserved},
		{name: "reserved via confusables", raw: "adm1n", err: ErrHandleReserved},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			display, canonical, err := Canonical(tt.raw)
			if tt.err != nil {
				require.ErrorIs(t, err, tt.err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.display, display)
			require.Equal(t, tt.canonical, canonical)
		})
	}
}

// The failure this prevents is not a missed lookup. It is sending a friend
// request to a stranger and then sharing body metrics with them, because
// `ada_l` and `ada_1` are indistinguishable when spoken.
func TestCanonical_ConfusableClassCollapsesToOneCanonicalForm(t *testing.T) {
	var got []string
	for _, raw := range []string{"ada_l", "ada_1", "ada_i", "ADA_I", "ada_L"} {
		_, canonical, err := Canonical(raw)
		require.NoError(t, err)
		got = append(got, canonical)
	}
	for _, c := range got {
		require.Equal(t, got[0], c, "every member of a confusable class must fold to one canonical form")
	}
}

func TestCanonical_OAndZeroFold(t *testing.T) {
	_, a, err := Canonical("b0b_smith")
	require.NoError(t, err)
	_, b, err := Canonical("bob_smith")
	require.NoError(t, err)
	require.Equal(t, a, b)
}

// Display keeps what the user typed (minus case and padding) so `ada_l` does
// not render back to them as `ada_1`.
func TestCanonical_DisplayIsNotFolded(t *testing.T) {
	display, canonical, err := Canonical("ada_l")
	require.NoError(t, err)
	require.Equal(t, "ada_l", display)
	require.NotEqual(t, display, canonical)
}

func TestErrorsAreDistinct(t *testing.T) {
	require.False(t, errors.Is(ErrHandleInvalid, ErrHandleReserved))
	require.False(t, errors.Is(ErrHandleTaken, ErrHandleRetired))
}
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd api && go test ./internal/identity/... -run TestCanonical -v
```

Expected: the package does not compile — `undefined: Canonical`.

- [ ] **Step 3: Write the implementation**

Create `api/internal/identity/errors.go`:

```go
package identity

import "errors"

// The four handle-write failures are distinct errors on purpose: the spec
// requires PUT /v1/me/handle to answer differently for "taken", "invalid
// shape", "reserved" and "retired". Collapsing any two of them turns a
// fixable mistake into a dead end for the person typing.
//
// "Taken" is deliberately NOT treated as a privacy leak. A handle's existence
// is discoverable by definition, since exact-match lookup exists.
var (
	ErrHandleInvalid  = errors.New("identity: handle has an invalid shape")
	ErrHandleReserved = errors.New("identity: handle is reserved")
	ErrHandleTaken    = errors.New("identity: handle is taken")
	ErrHandleRetired  = errors.New("identity: handle was retired and cannot be reused")
	ErrNotFound       = errors.New("identity: not found")
)
```

Create `api/internal/identity/handle.go`:

```go
// Package identity owns handles: the sayable name a Kora user can be found
// by, and the profile picture attached to it.
package identity

import "strings"

// Handle length bounds, measured on the display form. Three is the shortest
// thing worth saying aloud; twenty is longer than anyone will read out.
const (
	MinHandleLen = 3
	MaxHandleLen = 20
)

// reserved handles prevent impersonating Kora itself. The check runs against
// the CANONICAL form, not the display form, so `adm1n` is caught too — a
// reserved list that folding can walk around is not a reserved list.
var reserved = map[string]struct{}{
	"kora": {}, "admin": {}, "support": {}, "help": {}, "team": {},
}

// confusables maps every character in a spoken-ambiguity class to one
// representative. `l`, `i` and `1` are one class; `o` and `0` are another.
//
// This is applied to the canonical form, which the unique index is built on,
// so at most ONE handle can exist per confusable class. That is what makes
// folding on LOOKUP unambiguous rather than lossy: whichever member of the
// class exists is necessarily the one the speaker meant, so a handle heard
// correctly always resolves.
var confusables = map[rune]rune{
	'l': '1', 'i': '1', '1': '1',
	'o': '0', '0': '0',
}

// Canonical validates raw and returns the form to display and the form to
// index and look up by. Display is trimmed and lowercased but NOT folded, so
// a user who chose `ada_l` is never shown `ada_1` as their own handle.
func Canonical(raw string) (string, string, error) {
	display := strings.ToLower(strings.TrimSpace(raw))
	// People say and write handles with a leading @. Accepting it here means
	// pasting `@ada` from a message thread works, rather than failing shape
	// validation for a character that was never part of the handle.
	display = strings.TrimPrefix(display, "@")

	if len(display) < MinHandleLen || len(display) > MaxHandleLen {
		return "", "", ErrHandleInvalid
	}
	for _, r := range display {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			continue
		}
		return "", "", ErrHandleInvalid
	}

	var b strings.Builder
	b.Grow(len(display))
	for _, r := range display {
		if folded, ok := confusables[r]; ok {
			b.WriteRune(folded)
			continue
		}
		b.WriteRune(r)
	}
	canonical := b.String()

	if _, bad := reserved[canonical]; bad {
		return "", "", ErrHandleReserved
	}
	return display, canonical, nil
}
```

Note the length check uses `len` on a string that has already been proven ASCII
by the charset loop below it — the loop rejects any non-ASCII rune, so bytes and
characters are the same thing for every input that survives.

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd api && go test ./internal/identity/... -v
```

Expected: PASS, every subtest.

- [ ] **Step 5: Mutation-check the two tests that guard something**

Each of these must fail, and then be restored. Copy the file to `/tmp` first —
never `git checkout` a file that carries uncommitted new code.

```bash
cd api && cp internal/identity/handle.go /tmp/handle.go.bak
```

1. Delete the `'i': '1'` entry from `confusables`. Run the tests:
   `TestCanonical_ConfusableClassCollapsesToOneCanonicalForm` must FAIL. If it
   passes, the test is not exercising the class it claims to.
2. Restore. Change the reserved check to run on `display` instead of
   `canonical`. `TestCanonical/reserved_via_confusables` must FAIL.
3. Restore: `cp /tmp/handle.go.bak internal/identity/handle.go` and re-run to
   confirm green.

- [ ] **Step 6: Commit**

```bash
cd api && git add internal/identity/handle.go internal/identity/errors.go internal/identity/handle_test.go
git commit -m "feat(identity): handle canonicalisation with confusable folding (#449)"
```

---

### Task 2: Schema — handle columns, the partial unique index, and retired handles

**Files:**
- Create: `api/internal/database/migrations/000056_identity_handles_avatars.up.sql`
- Create: `api/internal/database/migrations/000056_identity_handles_avatars.down.sql`
- Modify: `api/internal/user/model.go` (add three fields to `User`)
- Test: `api/internal/identity/schema_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `users.handle`, `users.handle_canonical`,
  `users.avatar_path`; table `retired_handles (handle_canonical TEXT PRIMARY
  KEY, retired_at TIMESTAMPTZ)`; Go fields `user.User.Handle`,
  `user.User.HandleCanonical`, `user.User.AvatarPath`.

- [ ] **Step 1: Write the failing test**

Create `api/internal/identity/schema_test.go`:

```go
package identity

import (
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)`,
		id, "identity-"+id.String(), id.String()+"@example.test", "Test Person").Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

// The unique index is PARTIAL. Without the WHERE clause, the second user to
// have no handle at all collides with the first on NULL, which would break
// every existing account the moment this migration lands.
func TestSchema_TwoUsersMayBothHaveNoHandle(t *testing.T) {
	db := testDB(t)
	seedUser(t, db)
	seedUser(t, db)
}

func TestSchema_CanonicalHandleIsUnique(t *testing.T) {
	db := testDB(t)
	a, b := seedUser(t, db), seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = 'ada', handle_canonical = 'ada' WHERE id = ?`, a).Error)
	err := db.Exec(
		`UPDATE users SET handle = 'ada', handle_canonical = 'ada' WHERE id = ?`, b).Error
	require.Error(t, err, "a second user must not be able to take the same canonical handle")
}

// Two DIFFERENT display handles that fold to the same canonical form must
// still collide. This is the property the whole confusable decision rests on.
func TestSchema_ConfusableHandlesCollideOnCanonical(t *testing.T) {
	db := testDB(t)
	a, b := seedUser(t, db), seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = 'ada_l', handle_canonical = 'ada_1' WHERE id = ?`, a).Error)
	err := db.Exec(
		`UPDATE users SET handle = 'ada_1', handle_canonical = 'ada_1' WHERE id = ?`, b).Error
	require.Error(t, err)
}

func TestSchema_RetiredHandlesTableExists(t *testing.T) {
	db := testDB(t)
	h := "retired_" + uuid.NewString()[:8]
	require.NoError(t, db.Exec(
		`INSERT INTO retired_handles (handle_canonical) VALUES (?)`, h).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, h) })

	var retiredAt any
	require.NoError(t, db.Raw(
		`SELECT retired_at FROM retired_handles WHERE handle_canonical = ?`, h).Scan(&retiredAt).Error)
	require.NotNil(t, retiredAt, "retired_at must default to now(), not NULL")
}

// Retirement must OUTLIVE the account. If the row vanished with the user, a
// deleted account would hand its handle to whoever claims it next — which is
// exactly the impersonation retirement exists to prevent, with a body-metrics
// payoff. So retired_handles carries no foreign key to users.
func TestSchema_RetirementSurvivesAccountDeletion(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	h := "gone_" + uuid.NewString()[:8]
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = ?, handle_canonical = ? WHERE id = ?`, h, h, id).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO retired_handles (handle_canonical) VALUES (?)`, h).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, h) })

	require.NoError(t, db.Exec(`DELETE FROM users WHERE id = ?`, id).Error)

	var n int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM retired_handles WHERE handle_canonical = ?`, h).Scan(&n).Error)
	require.EqualValues(t, 1, n)
}
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd api && go test ./internal/identity/... -run TestSchema -p 1 -v
```

Expected: FAIL — `column "handle_canonical" of relation "users" does not exist`
and `relation "retired_handles" does not exist`. If instead every test SKIPS,
Postgres is not reachable: start it and re-run, because a skipped schema test
proves nothing.

- [ ] **Step 3: Write the migration**

Create `api/internal/database/migrations/000056_identity_handles_avatars.up.sql`:

```sql
-- Handles and profile pictures (kora#449). Supersedes #153's address-book
-- matching: Kora collects no phone numbers, and email-only matching is blind to
-- Apple relay addresses and makes people findable without a deliberate act.
--
-- A handle is exact-match only. There is no prefix search, no listing and no
-- directory anywhere in the API -- being findable in a weight app is
-- health-adjacent information, and a searchable directory would tell anyone who
-- cares who uses Kora.
ALTER TABLE users
    ADD COLUMN handle           TEXT,
    ADD COLUMN handle_canonical TEXT,
    ADD COLUMN avatar_path      TEXT;

-- PARTIAL, on the canonical form. Partial because most users have no handle and
-- NULLs must not collide. On the canonical form because `ada_l` and `ada_1` are
-- indistinguishable when spoken, and the failure that prevents is not a missed
-- lookup -- it is sending a friend request to a stranger and then sharing body
-- metrics with them.
CREATE UNIQUE INDEX users_handle_canonical_key
    ON users (handle_canonical) WHERE handle_canonical IS NOT NULL;

-- Changing your handle retires the old one PERMANENTLY. Otherwise anyone who
-- wrote down @ada sends requests to whoever claims it next.
--
-- No foreign key to users, and no ON DELETE CASCADE, deliberately: retirement
-- must outlive the account that held it, or deleting an account would return
-- its handle to the pool and reopen the same impersonation.
CREATE TABLE retired_handles (
    handle_canonical TEXT PRIMARY KEY,
    retired_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- avatar_path stores an OBJECT PATH, never a full URL: the bucket and CDN host
-- are deployment concerns, and baking today's infrastructure into user rows
-- means a bucket move rewrites the users table. The API composes the URL on read.
COMMENT ON COLUMN users.avatar_path IS
    'Object path (avatars/{user_id}/{version}.jpg), not a URL. The API composes the URL on read.';
```

Create `api/internal/database/migrations/000056_identity_handles_avatars.down.sql`:

```sql
DROP TABLE IF EXISTS retired_handles;
DROP INDEX IF EXISTS users_handle_canonical_key;
ALTER TABLE users
    DROP COLUMN IF EXISTS avatar_path,
    DROP COLUMN IF EXISTS handle_canonical,
    DROP COLUMN IF EXISTS handle;
```

- [ ] **Step 4: Add the Go fields**

In `api/internal/user/model.go`, inside `type User struct`, immediately after
the `FriendCode` field:

```go
	// Handle is what the user typed (trimmed and lowercased); HandleCanonical
	// is that with confusables folded, and is what the unique index and every
	// lookup use. Both are nullable in SQL and '' in Go for a user who has no
	// handle -- a presence check MUST be `!= ""`, the same trap AppleRefreshToken
	// documents above.
	//
	// json:"-" on both: they reach clients only through identity.LookupView and
	// social.FriendView, which are projections chosen field by field. Serialising
	// the model directly is how an email leaks.
	Handle          string `gorm:"column:handle" json:"-"`
	HandleCanonical string `gorm:"column:handle_canonical" json:"-"`

	// AvatarPath is an object path, never a URL. See the column comment in
	// migration 000056.
	AvatarPath string `gorm:"column:avatar_path" json:"-"`
```

- [ ] **Step 5: Apply the migration and run the tests**

```bash
cd api && go test ./internal/database/... -p 1 -v   # migration up/down both apply
go test ./internal/identity/... -p 1 -v
```

Expected: PASS. If `TestSchema_TwoUsersMayBothHaveNoHandle` fails, the `WHERE`
clause is missing from the index.

- [ ] **Step 6: Mutation-check the partial index**

Drop and recreate the index without its `WHERE handle_canonical IS NOT NULL`
clause by hand, re-run, and confirm `TestSchema_TwoUsersMayBothHaveNoHandle`
FAILS. Then restore it. A test that passes under both index definitions is not
testing the thing the index exists for.

- [ ] **Step 7: Commit**

```bash
cd api && git add internal/database/migrations/000056_identity_handles_avatars.up.sql \
  internal/database/migrations/000056_identity_handles_avatars.down.sql \
  internal/user/model.go internal/identity/schema_test.go
git commit -m "feat(identity): handle and avatar columns, partial unique index, retired handles (#449)"
```

---

### Task 3: Claim, clear, and look up a handle

**Files:**
- Create: `api/internal/identity/model.go`
- Create: `api/internal/identity/repository.go`
- Create: `api/internal/identity/service.go`
- Test: `api/internal/identity/service_test.go`

**Interfaces:**
- Consumes: `Canonical`, the five errors (Task 1); the schema (Task 2).
- Produces:
  - `type LookupView struct { ID uuid.UUID; DisplayName, Handle, AvatarURL string }`
  - `func NewRepository(db *gorm.DB) Repository`
  - `func NewService(repo Repository, avatarURL func(path string) string) Service`
  - `func (s Service) Claim(ctx context.Context, userID uuid.UUID, raw string) (string, error)`
  - `func (s Service) Clear(ctx context.Context, userID uuid.UUID) error`
  - `func (s Service) Lookup(ctx context.Context, raw string) (LookupView, error)`
  - `func (s Service) MyHandle(ctx context.Context, userID uuid.UUID) (string, error)`

- [ ] **Step 1: Write the failing test**

Create `api/internal/identity/service_test.go`:

```go
package identity

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newSvc(db *gorm.DB) Service {
	// A stand-in URL composer: Task 7 supplies the real one from assets.Store.
	return NewService(NewRepository(db), func(path string) string {
		if path == "" {
			return ""
		}
		return "https://assets.test/" + path
	})
}

func TestClaim_ThenLookupFindsIt(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical LIKE 'ada%'`) })

	display, err := svc.Claim(context.Background(), id, "@AdA")
	require.NoError(t, err)
	require.Equal(t, "ada", display)

	got, err := svc.Lookup(context.Background(), "ada")
	require.NoError(t, err)
	require.Equal(t, id, got.ID)
	require.Equal(t, "ada", got.Handle)
	require.Equal(t, "Test Person", got.DisplayName)
}

// Folding on lookup is what makes a handle heard correctly always resolve.
func TestLookup_FoldsConfusables(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	h := "ada_l"
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'ada_1'`) })

	_, err := svc.Claim(context.Background(), id, h)
	require.NoError(t, err)

	for _, spoken := range []string{"ada_l", "ada_1", "ada_i", "ADA_L", "@ada_1"} {
		got, err := svc.Lookup(context.Background(), spoken)
		require.NoError(t, err, "spoken form %q must resolve", spoken)
		require.Equal(t, id, got.ID)
		require.Equal(t, "ada_l", got.Handle, "the DISPLAY form is returned, not the folded one")
	}
}

func TestLookup_MissIsNotFound(t *testing.T) {
	db := testDB(t)
	_, err := newSvc(db).Lookup(context.Background(), "nobody_here_at_all")
	require.ErrorIs(t, err, ErrNotFound)
}

// A handle that could never have been claimed is still a miss, not a 400.
// The caller typed something; the answer is "no such person" either way.
func TestLookup_InvalidShapeIsNotFound(t *testing.T) {
	db := testDB(t)
	_, err := newSvc(db).Lookup(context.Background(), "no")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestClaim_TakenByAnotherUser(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	a, b := seedUser(t, db), seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'taken1'`) })

	_, err := svc.Claim(context.Background(), a, "takenl")
	require.NoError(t, err)

	// The confusable twin, from a different account.
	_, err = svc.Claim(context.Background(), b, "taken1")
	require.ErrorIs(t, err, ErrHandleTaken)
}

// Re-claiming your OWN handle is a no-op, not a conflict. Otherwise saving a
// profile form twice reads as "that handle is taken" — by yourself.
func TestClaim_SameHandleAgainIsFine(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'stab1e'`) })

	_, err := svc.Claim(context.Background(), id, "stable")
	require.NoError(t, err)
	_, err = svc.Claim(context.Background(), id, "stable")
	require.NoError(t, err)

	var n int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM retired_handles WHERE handle_canonical = 'stab1e'`).Scan(&n).Error)
	require.EqualValues(t, 0, n, "re-claiming your own handle must not retire it")
}

func TestClaim_ChangingRetiresTheOldOneAndFreesNothing(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	a, b := seedUser(t, db), seedUser(t, db)
	t.Cleanup(func() {
		db.Exec(`DELETE FROM retired_handles WHERE handle_canonical IN ('01dname', 'newname')`)
	})

	_, err := svc.Claim(context.Background(), a, "oldname")
	require.NoError(t, err)
	_, err = svc.Claim(context.Background(), a, "newname")
	require.NoError(t, err)

	// The old handle is gone from the user...
	_, err = svc.Lookup(context.Background(), "oldname")
	require.ErrorIs(t, err, ErrNotFound)
	// ...and nobody else can have it. Not even the person who released it.
	_, err = svc.Claim(context.Background(), b, "oldname")
	require.ErrorIs(t, err, ErrHandleRetired)
	_, err = svc.Claim(context.Background(), a, "oldname")
	require.ErrorIs(t, err, ErrHandleRetired)
}

func TestClear_RetiresTheHandle(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	a, b := seedUser(t, db), seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'dropped'`) })

	_, err := svc.Claim(context.Background(), a, "dropped")
	require.NoError(t, err)
	require.NoError(t, svc.Clear(context.Background(), a))

	_, err = svc.Lookup(context.Background(), "dropped")
	require.ErrorIs(t, err, ErrNotFound)
	_, err = svc.Claim(context.Background(), b, "dropped")
	require.ErrorIs(t, err, ErrHandleRetired)
}

func TestClear_WithNoHandleIsANoOp(t *testing.T) {
	db := testDB(t)
	require.NoError(t, newSvc(db).Clear(context.Background(), seedUser(t, db)))
}

func TestClaim_RejectsReservedAndInvalid(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	_, err := svc.Claim(context.Background(), id, "support")
	require.ErrorIs(t, err, ErrHandleReserved)
	_, err = svc.Claim(context.Background(), id, "no")
	require.ErrorIs(t, err, ErrHandleInvalid)
}

// The projection rule that share.MemberView and social.FriendView already
// follow, restated where it is easiest to break.
func TestLookupView_HasNoEmailField(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'pr1vate'`) })
	_, err := svc.Claim(context.Background(), id, "private")
	require.NoError(t, err)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, id).Scan(&email).Error)
	require.NotEmpty(t, email)

	got, err := svc.Lookup(context.Background(), "private")
	require.NoError(t, err)
	body, err := json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(body), email)
	require.NotContains(t, string(body), "email")
}

func TestLookup_ComposesAvatarURLFromPath(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'w1thp1c'`) })
	_, err := svc.Claim(context.Background(), id, "withpic")
	require.NoError(t, err)
	require.NoError(t, db.Exec(
		`UPDATE users SET avatar_path = ? WHERE id = ?`, "avatars/"+id.String()+"/v1.jpg", id).Error)

	got, err := svc.Lookup(context.Background(), "withpic")
	require.NoError(t, err)
	require.Equal(t, "https://assets.test/avatars/"+id.String()+"/v1.jpg", got.AvatarURL)
}

// No picture is an empty string, never a broken URL. The client falls back to
// initials on empty; a "https://assets.test/" pointing at nothing renders as a
// broken image inside a friend row.
func TestLookup_NoAvatarIsEmptyURL(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'n0p1c'`) })
	_, err := svc.Claim(context.Background(), id, "nopic")
	require.NoError(t, err)

	got, err := svc.Lookup(context.Background(), "nopic")
	require.NoError(t, err)
	require.Empty(t, got.AvatarURL)
}
```

Imports for this file: `context`, `encoding/json`, `testing`,
`github.com/stretchr/testify/require`, `gorm.io/gorm`. Not `uuid` — `seedUser`
lives in `schema_test.go` and its import travels with it.

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd api && go test ./internal/identity/... -p 1 -v
```

Expected: compile failure — `undefined: NewService`.

- [ ] **Step 3: Write the model and repository**

Create `api/internal/identity/model.go`:

```go
package identity

import "github.com/google/uuid"

// LookupView is everything a handle lookup returns. It is a PROJECTION chosen
// field by field, following the same rule as social.FriendView and
// share.MemberView: never an email, never the model struct.
//
// The avatar is here, at lookup, rather than after friendship, because the
// handle IS the consent boundary: if you gave someone your handle they may see
// your face. Deferring the picture until after a request is accepted would not
// solve the problem it exists for -- you would still be sending that request
// based on a display name that is not unique.
type LookupView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Handle      string    `json:"handle"`
	// AvatarURL is "" when the user has no picture. The client falls back to
	// initials on empty, so a URL that resolves to nothing is worse than none.
	AvatarURL string `json:"avatar_url"`
}
```

Create `api/internal/identity/repository.go`:

```go
package identity

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

type Repository struct{ db *gorm.DB }

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// FindByCanonical resolves a FOLDED handle to its owner. There is exactly one
// query shape in this package that reads by handle, and it is this one: an
// unfolded or prefix variant added later would quietly reopen enumeration.
func (r Repository) FindByCanonical(ctx context.Context, canonical string) (user.User, error) {
	var u user.User
	err := r.db.WithContext(ctx).
		Where("handle_canonical = ?", canonical).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return user.User{}, ErrNotFound
	}
	if err != nil {
		return user.User{}, fmt.Errorf("identity: find by handle: %w", err)
	}
	return u, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (user.User, error) {
	var u user.User
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return user.User{}, ErrNotFound
	}
	if err != nil {
		return user.User{}, fmt.Errorf("identity: find user: %w", err)
	}
	return u, nil
}

func (r Repository) IsRetired(ctx context.Context, canonical string) (bool, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Raw(`SELECT count(*) FROM retired_handles WHERE handle_canonical = ?`, canonical).
		Scan(&n).Error
	if err != nil {
		return false, fmt.Errorf("identity: check retired: %w", err)
	}
	return n > 0, nil
}

// SetHandle writes the new handle and retires the previous one in ONE
// transaction. Splitting them would leave a window where a crash between the
// two statements either loses the retirement (the old handle returns to the
// pool -- the impersonation this design exists to prevent) or retires a handle
// the user still holds.
//
// prevCanonical is "" when the user had no handle; nothing is retired then.
func (r Repository) SetHandle(ctx context.Context, id uuid.UUID, display, canonical, prevCanonical string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if prevCanonical != "" && prevCanonical != canonical {
			if err := tx.Exec(
				`INSERT INTO retired_handles (handle_canonical) VALUES (?)
				 ON CONFLICT (handle_canonical) DO NOTHING`, prevCanonical).Error; err != nil {
				return fmt.Errorf("identity: retire previous handle: %w", err)
			}
		}
		out := tx.Exec(
			`UPDATE users SET handle = ?, handle_canonical = ? WHERE id = ?`,
			display, canonical, id)
		if out.Error != nil {
			return out.Error
		}
		if out.RowsAffected == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// ClearHandle drops the user's handle and retires it, in one transaction, for
// the same reason SetHandle does.
func (r Repository) ClearHandle(ctx context.Context, id uuid.UUID, prevCanonical string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if prevCanonical != "" {
			if err := tx.Exec(
				`INSERT INTO retired_handles (handle_canonical) VALUES (?)
				 ON CONFLICT (handle_canonical) DO NOTHING`, prevCanonical).Error; err != nil {
				return fmt.Errorf("identity: retire handle on clear: %w", err)
			}
		}
		return tx.Exec(
			`UPDATE users SET handle = NULL, handle_canonical = NULL WHERE id = ?`, id).Error
	})
}
```

- [ ] **Step 4: Write the service**

Create `api/internal/identity/service.go`:

```go
package identity

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

// Service owns the handle lifecycle. avatarURL composes a public URL from the
// stored object PATH; it is a func rather than an assets.Store so this package
// does not depend on object storage to be tested, and so the URL scheme stays a
// deployment concern rather than something baked into user rows.
type Service struct {
	repo      Repository
	avatarURL func(path string) string
}

func NewService(repo Repository, avatarURL func(path string) string) Service {
	return Service{repo: repo, avatarURL: avatarURL}
}

// Claim sets the caller's handle, retiring whatever they held before.
//
// Re-claiming your own current handle is a no-op that returns success and
// retires nothing: saving a profile form twice must not tell someone their own
// handle is taken.
func (s Service) Claim(ctx context.Context, userID uuid.UUID, raw string) (string, error) {
	display, canonical, err := Canonical(raw)
	if err != nil {
		return "", err
	}

	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}
	if me.HandleCanonical == canonical {
		return me.Handle, nil
	}

	retired, err := s.repo.IsRetired(ctx, canonical)
	if err != nil {
		return "", err
	}
	if retired {
		return "", ErrHandleRetired
	}

	// Checked before the write for a clear error message, and enforced again
	// by the unique index below -- two callers racing for the same handle both
	// pass this check, and only one survives the INSERT.
	if owner, err := s.repo.FindByCanonical(ctx, canonical); err == nil {
		if owner.ID != userID {
			return "", ErrHandleTaken
		}
	} else if err != ErrNotFound {
		return "", err
	}

	if err := s.repo.SetHandle(ctx, userID, display, canonical, me.HandleCanonical); err != nil {
		// The partial unique index is the real arbiter of a race; translate
		// its violation into the same error the pre-check produces.
		if strings.Contains(err.Error(), "users_handle_canonical_key") {
			return "", ErrHandleTaken
		}
		return "", err
	}
	return display, nil
}

// Clear removes the caller's handle and retires it permanently. Clearing when
// you have no handle succeeds and does nothing.
func (s Service) Clear(ctx context.Context, userID uuid.UUID) error {
	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return err
	}
	if me.HandleCanonical == "" {
		return nil
	}
	return s.repo.ClearHandle(ctx, userID, me.HandleCanonical)
}

// MyHandle returns the caller's own display handle, or "" if they have none.
func (s Service) MyHandle(ctx context.Context, userID uuid.UUID) (string, error) {
	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}
	return me.Handle, nil
}

// Lookup resolves a spoken handle to one person. EXACT MATCH ONLY, after
// folding -- there is no prefix variant of this method and there must never be
// one, because prefix search would make the whole user base enumerable and tell
// anyone who cares who uses a calorie tracker.
//
// A handle that cannot even be a handle (wrong shape, reserved) returns
// ErrNotFound rather than a validation error: the caller asked "who is this",
// and "nobody" is the honest answer for every input that no account can hold.
func (s Service) Lookup(ctx context.Context, raw string) (LookupView, error) {
	_, canonical, err := Canonical(raw)
	if err != nil {
		return LookupView{}, ErrNotFound
	}
	u, err := s.repo.FindByCanonical(ctx, canonical)
	if err != nil {
		return LookupView{}, err
	}
	return LookupView{
		ID:          u.ID,
		DisplayName: u.DisplayName,
		Handle:      u.Handle,
		AvatarURL:   s.avatarURL(u.AvatarPath),
	}, nil
}
```

- [ ] **Step 5: Run the tests**

```bash
cd api && go test ./internal/identity/... -p 1 -v
```

Expected: PASS.

- [ ] **Step 6: Mutation-check the three tests that guard something**

Copy `service.go` to `/tmp` first.

1. In `Lookup`, use `display` instead of `canonical` in the `FindByCanonical`
   call. `TestLookup_FoldsConfusables` must FAIL.
2. In `Claim`, delete the `IsRetired` check.
   `TestClaim_ChangingRetiresTheOldOneAndFreesNothing` must FAIL on the
   `ErrHandleRetired` assertion.
3. In `Claim`, remove the `me.HandleCanonical == canonical` early return.
   `TestClaim_SameHandleAgainIsFine` must FAIL — and note *which* assertion
   fails: if only the `require.NoError` fails and the retired-count assertion
   would have passed anyway, the second half of that test is not earning its
   place.

Restore from `/tmp` and confirm green.

- [ ] **Step 7: Commit**

```bash
cd api && git add internal/identity/
git commit -m "feat(identity): claim, clear, and exact-match lookup with permanent retirement (#449)"
```

---

### Task 4: A per-caller rate limiter

There is no rate limiting anywhere in this API today. This is the first, and it
exists for one reason: exact-match lookup with no limit is offline enumeration
at HTTP speed.

**Files:**
- Create: `api/internal/ratelimit/window.go`
- Create: `api/internal/ratelimit/middleware.go`
- Test: `api/internal/ratelimit/window_test.go`
- Test: `api/internal/ratelimit/middleware_test.go`

**Interfaces:**
- Consumes: `user.IDFromContext` (`api/internal/user/middleware.go:43`).
- Produces:
  - `func NewWindow(limit int, period time.Duration) *Window`
  - `func (w *Window) Allow(key string, now time.Time) bool`
  - `func PerUser(limit int, period time.Duration) gin.HandlerFunc`

- [ ] **Step 1: Write the failing tests**

Create `api/internal/ratelimit/window_test.go`:

```go
package ratelimit

import (
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var t0 = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

func TestWindow_AllowsUpToTheLimitThenRefuses(t *testing.T) {
	w := NewWindow(3, time.Minute)
	for i := 0; i < 3; i++ {
		require.True(t, w.Allow("u1", t0), "call %d must be allowed", i+1)
	}
	require.False(t, w.Allow("u1", t0), "the call past the limit must be refused")
}

func TestWindow_KeysAreIndependent(t *testing.T) {
	w := NewWindow(1, time.Minute)
	require.True(t, w.Allow("u1", t0))
	require.False(t, w.Allow("u1", t0))
	require.True(t, w.Allow("u2", t0), "one user's limit must not spend another's")
}

// Both bounds. A test that only proves the window reopens after a long wait
// would pass against an implementation with no window at all.
func TestWindow_ResetsOnlyAfterThePeriod(t *testing.T) {
	w := NewWindow(1, time.Minute)
	require.True(t, w.Allow("u1", t0))
	require.False(t, w.Allow("u1", t0.Add(59*time.Second)), "still inside the window")
	require.True(t, w.Allow("u1", t0.Add(61*time.Second)), "past the window")
}

func TestWindow_IsSafeUnderConcurrency(t *testing.T) {
	w := NewWindow(100, time.Minute)
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w.Allow("shared", t0) {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	require.Equal(t, 100, allowed, "exactly the limit, no more and no fewer")
}

// The map must not grow without bound: every distinct key is a heap entry, and
// keys are user ids supplied by whoever is calling.
func TestWindow_EvictsStaleKeys(t *testing.T) {
	w := NewWindow(1, time.Minute)
	for i := 0; i < 500; i++ {
		w.Allow("u"+strconv.Itoa(i), t0)
	}
	w.Allow("fresh", t0.Add(2*time.Minute))
	require.LessOrEqual(t, w.Size(), 1,
		"keys whose window has closed must be dropped, not kept forever")
}
```

Create `api/internal/ratelimit/middleware_test.go`:

```go
package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/user"
)

func routerWithUser(t *testing.T, id uuid.UUID, limit int) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/thing",
		func(c *gin.Context) { user.SetIDForTest(c, id); c.Next() },
		PerUser(limit, time.Minute),
		func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"data": "ok"}) })
	return r
}

func call(r *gin.Engine) int {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/thing", nil))
	return rec.Code
}

func TestPerUser_RefusesPastTheLimitWith429(t *testing.T) {
	r := routerWithUser(t, uuid.New(), 2)
	require.Equal(t, 200, call(r))
	require.Equal(t, 200, call(r))
	require.Equal(t, http.StatusTooManyRequests, call(r))
}

// A refusal must ABORT. If the middleware only sets a status and calls Next,
// the handler still runs and still answers — the limit would be decorative.
func TestPerUser_RefusalNeverReachesTheHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	id := uuid.New()
	reached := 0
	r := gin.New()
	r.GET("/thing",
		func(c *gin.Context) { user.SetIDForTest(c, id); c.Next() },
		PerUser(1, time.Minute),
		func(c *gin.Context) { reached++; c.JSON(200, gin.H{"data": "ok"}) })

	call(r)
	call(r)
	require.Equal(t, 1, reached, "the refused request must not reach the handler")
}

// An unauthenticated request has no key to limit on. It must be refused
// outright rather than sharing one bucket labelled "" with every other
// anonymous caller — which would be a free enumeration channel.
func TestPerUser_UnauthenticatedIs401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/thing", PerUser(5, time.Minute), func(c *gin.Context) { c.JSON(200, gin.H{}) })
	require.Equal(t, http.StatusUnauthorized, call(r))
}
```

`user.SetIDForTest` may not exist. Check first:
`grep -rn "SetIDForTest\|contextUserID" api/internal/user/middleware.go`. If it
does not, add it to `middleware.go` next to `IDFromContext`:

```go
// SetIDForTest puts a user id on the context the same way the auth middleware
// does. Exported only so packages that sit BEHIND auth can test their own
// middleware without a Firebase token.
func SetIDForTest(c *gin.Context, id uuid.UUID) { c.Set(contextUserID, id) }
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd api && go test ./internal/ratelimit/... -v
```

Expected: compile failure — `undefined: NewWindow`.

- [ ] **Step 3: Write the window**

Create `api/internal/ratelimit/window.go`:

```go
// Package ratelimit provides the API's first rate limiter. It exists for one
// endpoint: exact-match handle lookup, where an unlimited caller can walk the
// handle space offline and learn who uses a calorie tracker.
package ratelimit

import (
	"sync"
	"time"
)

// Window is a fixed-window counter held IN PROCESS, deliberately.
//
// The obvious alternative is Redis, and it is the wrong one here. Redis in this
// API is OPTIONAL: cmd/api/main.go falls back to ai.NoCache{} when REDIS_URL
// does not parse or the client will not connect, and every other consumer
// degrades to "no caching" without complaint. A Redis-backed limiter inherits
// that posture and fails OPEN -- silently, with no signal, at exactly the moment
// infrastructure is unhealthy. For the one control standing between exact-match
// lookup and enumeration, failing open is not an acceptable degradation.
//
// In process, the counter cannot fail open, and kora-api runs a single replica
// today so the limit is exact. If it is ever scaled out, the effective limit
// becomes limit x replicas -- which is a LOOSER limit, not a broken one, and a
// deliberate trade rather than a bug. Move to a shared store only alongside a
// decision about what happens when that store is down.
type Window struct {
	limit  int
	period time.Duration

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	count int
	start time.Time
}

func NewWindow(limit int, period time.Duration) *Window {
	return &Window{limit: limit, period: period, buckets: map[string]*bucket{}}
}

// Allow reports whether key may make one more call at now, and counts it if so.
// now is a parameter rather than time.Now() so the window's BOUNDARIES can be
// tested without sleeping.
func (w *Window) Allow(key string, now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.evictLocked(now)

	b, ok := w.buckets[key]
	if !ok || now.Sub(b.start) >= w.period {
		w.buckets[key] = &bucket{count: 1, start: now}
		return true
	}
	if b.count >= w.limit {
		return false
	}
	b.count++
	return true
}

// Size reports how many keys are held. Exported for the eviction test: without
// it, "the map does not grow forever" is not observable from outside.
func (w *Window) Size() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.buckets)
}

// evictLocked drops every bucket whose window has closed. Keys are user ids
// from authenticated requests, so this map's growth is bounded by active users
// rather than by an attacker -- but an unbounded map that is only ever added to
// is a leak regardless of who fills it, and the sweep is cheap at this scale.
func (w *Window) evictLocked(now time.Time) {
	for k, b := range w.buckets {
		if now.Sub(b.start) >= w.period {
			delete(w.buckets, k)
		}
	}
}
```

- [ ] **Step 4: Write the middleware**

Create `api/internal/ratelimit/middleware.go`:

```go
package ratelimit

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// PerUser limits each authenticated caller to limit requests per period.
//
// The key is the AUTHENTICATED USER ID, not the client IP: a mobile client's IP
// is a carrier NAT shared by thousands of people, so limiting on it would
// throttle strangers for each other while a single account behind many IPs
// would not be limited at all.
//
// An unauthenticated request is refused with 401 rather than limited under a
// shared empty key -- one bucket for every anonymous caller is a free
// enumeration channel for the first one to use it.
func PerUser(limit int, period time.Duration) gin.HandlerFunc {
	w := NewWindow(limit, period)
	return func(c *gin.Context) {
		id, ok := user.IDFromContext(c)
		if !ok {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		if !w.Allow(id.String(), time.Now()) {
			// httpx.Error calls AbortWithStatusJSON, so the handler never runs.
			httpx.Error(c, http.StatusTooManyRequests, "rate_limited",
				"Too many lookups. Try again in a minute.")
			return
		}
		c.Next()
	}
}
```

- [ ] **Step 5: Run the tests**

```bash
cd api && go test ./internal/ratelimit/... -race -v
```

Expected: PASS, including under `-race`.

- [ ] **Step 6: Mutation-check**

Copy both files to `/tmp` first.

1. In `Allow`, change `b.count >= w.limit` to `b.count > w.limit`.
   `TestWindow_AllowsUpToTheLimitThenRefuses` must FAIL (off by one).
2. Delete the `w.evictLocked(now)` call. `TestWindow_EvictsStaleKeys` must FAIL.
3. In `PerUser`, replace the `httpx.Error(... 429 ...); return` with
   `c.Status(http.StatusTooManyRequests); c.Next()`.
   `TestPerUser_RefusalNeverReachesTheHandler` must FAIL. This is the one that
   matters most — it is the difference between a limiter and a decoration.
4. Restore all three and confirm green.

- [ ] **Step 7: Commit**

```bash
cd api && git add internal/ratelimit/ internal/user/middleware.go
git commit -m "feat(ratelimit): in-process per-user fixed window, the API's first limiter (#449)"
```

---

### Task 5: The handle endpoints

`GET /v1/users/lookup`, `PUT /v1/me/handle`, `DELETE /v1/me/handle`, and
`GET /v1/me/handle`. Avatar endpoints come later, in Task 8.

**Files:**
- Create: `api/internal/identity/handler.go`
- Modify: `api/internal/server/router.go` (after the `share` block, ~line 365)
- Test: `api/internal/identity/handler_test.go`

**Interfaces:**
- Consumes: `Service` (Task 3), `ratelimit.PerUser` (Task 4).
- Produces:
  - `func NewHandler(svc Service) Handler`
  - `Handler.Lookup`, `Handler.SetHandle`, `Handler.ClearHandle`, `Handler.GetHandle`
  - `const LookupLimit = 20`, `const LookupPeriod = time.Minute`

- [ ] **Step 1: Write the failing test**

Create `api/internal/identity/handler_test.go`. Follow the pattern in
`api/internal/social/handler_test.go` — read it first for how that package
builds a gin engine with a user on the context.

```go
package identity

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

func engine(t *testing.T, db *gorm.DB, as uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewHandler(newSvc(db))
	r := gin.New()
	r.Use(func(c *gin.Context) {
		if as != uuid.Nil {
			user.SetIDForTest(c, as)
		}
		c.Next()
	})
	r.GET("/v1/users/lookup", h.Lookup)
	r.GET("/v1/me/handle", h.GetHandle)
	r.PUT("/v1/me/handle", h.SetHandle)
	r.DELETE("/v1/me/handle", h.ClearHandle)
	return r
}

func do(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	return rec
}

func TestHandler_SetThenLookup(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'ada10ve'`) })
	r := engine(t, db, id)

	rec := do(r, http.MethodPut, "/v1/me/handle", `{"handle":"adalove"}`)
	require.Equal(t, 200, rec.Code, rec.Body.String())

	rec = do(r, http.MethodGet, "/v1/users/lookup?handle=ADALOVE", "")
	require.Equal(t, 200, rec.Code)

	var env struct{ Data LookupView }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Equal(t, id, env.Data.ID)
	require.Equal(t, "adalove", env.Data.Handle)
}

func TestHandler_LookupMissIs404(t *testing.T) {
	db := testDB(t)
	r := engine(t, db, seedUser(t, db))
	require.Equal(t, 404, do(r, http.MethodGet, "/v1/users/lookup?handle=nobodyhere", "").Code)
}

func TestHandler_LookupWithNoHandleParamIs400(t *testing.T) {
	db := testDB(t)
	r := engine(t, db, seedUser(t, db))
	require.Equal(t, 400, do(r, http.MethodGet, "/v1/users/lookup", "").Code)
}

// The four write failures answer differently. Collapsing any two turns a
// fixable mistake into a dead end for the person typing.
func TestHandler_WriteErrorsAreDistinguishable(t *testing.T) {
	db := testDB(t)
	a, b := seedUser(t, db), seedUser(t, db)
	t.Cleanup(func() {
		db.Exec(`DELETE FROM retired_handles WHERE handle_canonical IN ('m1ne', 'g0ne')`)
	})

	ra, rb := engine(t, db, a), engine(t, db, b)
	require.Equal(t, 200, do(ra, http.MethodPut, "/v1/me/handle", `{"handle":"mine"}`).Code)

	cases := []struct {
		name, body, code string
		status           int
	}{
		{name: "invalid shape", body: `{"handle":"no"}`, status: 400, code: "invalid_handle"},
		{name: "reserved", body: `{"handle":"support"}`, status: 409, code: "handle_reserved"},
		{name: "taken", body: `{"handle":"m1ne"}`, status: 409, code: "handle_taken"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			rec := do(rb, http.MethodPut, "/v1/me/handle", tt.body)
			require.Equal(t, tt.status, rec.Code, rec.Body.String())
			var e struct{ Error string }
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e))
			require.Equal(t, tt.code, e.Error)
		})
	}

	// Retired needs its own history: claim, move away, then try to take it back.
	require.Equal(t, 200, do(rb, http.MethodPut, "/v1/me/handle", `{"handle":"gone"}`).Code)
	require.Equal(t, 200, do(rb, http.MethodPut, "/v1/me/handle", `{"handle":"elsewhere"}`).Code)
	rec := do(ra, http.MethodPut, "/v1/me/handle", `{"handle":"gone"}`)
	require.Equal(t, 409, rec.Code)
	var e struct{ Error string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e))
	require.Equal(t, "handle_retired", e.Error)
	db.Exec(`DELETE FROM retired_handles WHERE handle_canonical IN ('e1sewhere')`)
}

func TestHandler_ClearThenGetIsEmpty(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'temp0rary'`) })
	r := engine(t, db, id)

	require.Equal(t, 200, do(r, http.MethodPut, "/v1/me/handle", `{"handle":"temporary"}`).Code)
	require.Equal(t, 204, do(r, http.MethodDelete, "/v1/me/handle", "").Code)

	rec := do(r, http.MethodGet, "/v1/me/handle", "")
	require.Equal(t, 200, rec.Code)
	var env struct{ Data struct{ Handle string } }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Empty(t, env.Data.Handle)
}

func TestHandler_UnauthenticatedIs401(t *testing.T) {
	db := testDB(t)
	r := engine(t, db, uuid.Nil)
	require.Equal(t, 401, do(r, http.MethodGet, "/v1/users/lookup?handle=ada", "").Code)
	require.Equal(t, 401, do(r, http.MethodPut, "/v1/me/handle", `{"handle":"ada"}`).Code)
}

// A lookup response must never carry an email, even when the target has one.
func TestHandler_LookupResponseHasNoEmail(t *testing.T) {
	db := testDB(t)
	target := seedUser(t, db)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = 'seen'`) })
	require.Equal(t, 200,
		do(engine(t, db, target), http.MethodPut, "/v1/me/handle", `{"handle":"seen"}`).Code)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, target).Scan(&email).Error)

	rec := do(engine(t, db, seedUser(t, db)), http.MethodGet, "/v1/users/lookup?handle=seen", "")
	require.Equal(t, 200, rec.Code)
	require.NotContains(t, rec.Body.String(), email)
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd api && go test ./internal/identity/... -run TestHandler -p 1 -v
```

Expected: compile failure — `undefined: NewHandler`.

- [ ] **Step 3: Write the handler**

Create `api/internal/identity/handler.go`:

```go
package identity

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// Lookup is limited to LookupLimit calls per LookupPeriod per authenticated
// caller. 20/minute is generous for a human typing a handle a friend read out,
// and ruinous for walking the handle space: even at the full rate, enumerating
// a five-character alphabet takes longer than the app will exist.
const (
	LookupLimit  = 20
	LookupPeriod = time.Minute
)

type Handler struct{ svc Service }

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

// writeErr maps the four write failures to four distinguishable answers.
//
// "Taken" is answered honestly, and that is not a privacy leak: a handle's
// existence is discoverable by definition, because exact-match lookup exists.
// Hiding it here would only make claiming a handle a guessing game.
func writeErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrHandleInvalid):
		httpx.Error(c, http.StatusBadRequest, "invalid_handle",
			"Handles are 3–20 characters: letters, numbers and underscores.")
	case errors.Is(err, ErrHandleReserved):
		httpx.Error(c, http.StatusConflict, "handle_reserved",
			"That handle is reserved.")
	case errors.Is(err, ErrHandleTaken):
		httpx.Error(c, http.StatusConflict, "handle_taken",
			"That handle is taken.")
	case errors.Is(err, ErrHandleRetired):
		httpx.Error(c, http.StatusConflict, "handle_retired",
			"That handle was used before and can't be reused.")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "not found")
	default:
		httpx.RespondServiceError(c, err)
	}
}

// Lookup resolves one handle to one person. There is no listing form of this
// endpoint and there must never be one.
func (h Handler) Lookup(c *gin.Context) {
	if _, ok := h.resolveUser(c); !ok {
		return
	}
	raw := c.Query("handle")
	if raw == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "handle is required")
		return
	}
	view, err := h.svc.Lookup(c.Request.Context(), raw)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "No Kora account has that handle.")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, view)
}

func (h Handler) GetHandle(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	handle, err := h.svc.MyHandle(c.Request.Context(), uid)
	if err != nil {
		writeErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"handle": handle})
}

func (h Handler) SetHandle(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var body struct {
		Handle string `json:"handle"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "handle is required")
		return
	}
	handle, err := h.svc.Claim(c.Request.Context(), uid, body.Handle)
	if err != nil {
		writeErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"handle": handle})
}

func (h Handler) ClearHandle(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if err := h.svc.Clear(c.Request.Context(), uid); err != nil {
		writeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
```

- [ ] **Step 4: Wire the routes**

In `api/internal/server/router.go`, add `"github.com/tesserix/kora/api/internal/identity"`
and `"github.com/tesserix/kora/api/internal/ratelimit"` to the import block, then
insert this immediately after the `v1.POST("/share/circles/:id/leave", ...)`
line (~365). Task 8 replaces the `nil` URL composer with the real one.

```go
		// Handles (kora#449). Exact match only: there is no listing or prefix
		// route here, and adding one would make the user base enumerable.
		identityHandler := identity.NewHandler(
			identity.NewService(identity.NewRepository(deps.DB), func(string) string { return "" }))
		v1.GET("/me/handle", identityHandler.GetHandle)
		v1.PUT("/me/handle", identityHandler.SetHandle)
		v1.DELETE("/me/handle", identityHandler.ClearHandle)
		// The limiter is on LOOKUP only, and it is not an optimisation: it is
		// the only thing between exact-match lookup and offline enumeration.
		v1.GET("/users/lookup",
			ratelimit.PerUser(identity.LookupLimit, identity.LookupPeriod),
			identityHandler.Lookup)
```

- [ ] **Step 5: Run the tests**

```bash
cd api && go test ./internal/identity/... ./internal/server/... -p 1
go build ./...
```

Expected: PASS.

- [ ] **Step 6: Mutation-check**

Copy `handler.go` to `/tmp`. Merge the `ErrHandleRetired` case into the
`ErrHandleTaken` case. `TestHandler_WriteErrorsAreDistinguishable` must FAIL on
the retired assertion. Restore.

- [ ] **Step 7: Verify the route is actually mounted, on a running API**

A green test suite does not prove the route is reachable — the handler tests
build their own engine. Restart the API and hit it. **`pkill -f "go run"` kills
the wrapper, not the binary**: the old listener survives on :8080 and serves the
old route table, which reads as "route not found".

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN     # kill THAT pid
cd api && go run ./cmd/api &
curl -s localhost:8080/ready          # /ready touches the DB; /health does not
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/v1/users/lookup?handle=ada
```

Expected: `401` (no token), **not** `404`. A 404 means the route did not mount.

- [ ] **Step 8: Commit**

```bash
cd api && git add internal/identity/handler.go internal/identity/handler_test.go internal/server/router.go
git commit -m "feat(identity): handle endpoints and rate-limited exact-match lookup (#449)"
```

---

## Phase B — the picture (API)

### Task 6: Share the image primitives, and fix the comment the spec was written from

`internal/bodyread` already owns both things an avatar pipeline needs: the
decode-bomb guard and a resampler. Move them to a shared package rather than
re-deriving them, and delete the stale package comment that claims this file
uses nearest-neighbour — it does not, and that comment is what produced the
spec's "x/image is a genuine new dependency" line.

**Files:**
- Create: `api/internal/imageproc/decode.go`
- Create: `api/internal/imageproc/resize.go`
- Create: `api/internal/imageproc/avatar.go`
- Modify: `api/internal/bodyread/downscale.go`
- Test: `api/internal/imageproc/avatar_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const MaxDecodePixels = 50_000_000`
  - `func DeclaredPixelsExceedCap(data []byte) bool`
  - `func BoxAverageResize(src image.Image, w, h int) *image.RGBA`
  - `const AvatarDimension = 512`, `const MaxAvatarBytes = 8 << 20`
  - `func NormalizeAvatar(data []byte) ([]byte, error)`
  - `var ErrUnreadableImage, ErrImageTooLarge error`

- [ ] **Step 1: Write the failing test**

Create `api/internal/imageproc/avatar_test.go`:

```go
package imageproc

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/stretchr/testify/require"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

// A PNG input must come out as a JPEG. Re-encoding is not a format preference:
// it is HOW EXIF is removed, including the GPS coordinates a selfie carries.
// Stripping named metadata fields would leave whatever fields we did not think
// to name.
func TestNormalizeAvatar_AlwaysProducesJPEG(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 900, 900))
	require.NoError(t, err)
	_, format, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, "jpeg", format)
}

func TestNormalizeAvatar_ResizesDownTo512(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 2000, 1200))
	require.NoError(t, err)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, AvatarDimension, cfg.Width)
	require.Equal(t, AvatarDimension, cfg.Height, "an avatar is square")
}

// Upscaling a small picture would invent detail and make a 60x60 thumbnail look
// worse, not better, while quadrupling the bytes stored.
func TestNormalizeAvatar_DoesNotUpscale(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 120, 120))
	require.NoError(t, err)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, 120, cfg.Width)
	require.Equal(t, 120, cfg.Height)
}

// A crafted header declares enormous dimensions in a few bytes while staying
// under any byte cap. image.Decode allocates the FULL pixel buffer for whatever
// the header claims, so this must be refused BEFORE the decode, not after.
func TestNormalizeAvatar_RejectsADecodeBombHeader(t *testing.T) {
	// A valid PNG header declaring 60000x60000 (3.6e9 px) with no pixel data.
	bomb := craftPNGHeader(t, 60000, 60000)
	require.True(t, DeclaredPixelsExceedCap(bomb),
		"the cap comparison itself must fire on the header alone")

	_, err := NormalizeAvatar(bomb)
	require.ErrorIs(t, err, ErrImageTooLarge)
}

func TestNormalizeAvatar_RejectsBytesThatAreNotAnImage(t *testing.T) {
	_, err := NormalizeAvatar([]byte("this is not an image"))
	require.ErrorIs(t, err, ErrUnreadableImage)
}

// EXIF is absent because the output was re-encoded from pixels. This asserts
// the OUTPUT does not carry the marker, which is the property that matters —
// a test that only checked the input had one would prove nothing.
func TestNormalizeAvatar_OutputCarriesNoEXIF(t *testing.T) {
	withEXIF := jpegWithEXIF(t)
	require.Contains(t, string(withEXIF), "Exif", "fixture must actually carry EXIF")

	out, err := NormalizeAvatar(withEXIF)
	require.NoError(t, err)
	require.NotContains(t, string(out), "Exif")
	require.NotContains(t, string(out), "GPS")
}

// A non-square input is centre-cropped, not squashed. A squashed face in a
// 30px circle is the defect this prevents.
func TestNormalizeAvatar_CropsRatherThanSquashes(t *testing.T) {
	out, err := NormalizeAvatar(pngBytes(t, 1000, 500))
	require.NoError(t, err)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, cfg.Width, cfg.Height)
}

func TestNormalizeAvatar_RejectsOversizedBytes(t *testing.T) {
	_, err := NormalizeAvatar(make([]byte, MaxAvatarBytes+1))
	require.ErrorIs(t, err, ErrImageTooLarge)
}

// craftPNGHeader builds a structurally valid PNG IHDR declaring w x h with no
// image data, which is exactly the shape of a decode bomb.
func craftPNGHeader(t *testing.T, w, h uint32) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], w)
	binary.BigEndian.PutUint32(ihdr[4:8], h)
	ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12] = 8, 6, 0, 0, 0 // 8-bit RGBA
	binary.Write(&buf, binary.BigEndian, uint32(len(ihdr)))
	chunk := append([]byte("IHDR"), ihdr...)
	buf.Write(chunk)
	binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buf.Bytes()
}

// jpegWithEXIF produces a JPEG carrying an APP1/Exif segment, so the
// no-EXIF-on-output assertion has something real to be the absence of.
func jpegWithEXIF(t *testing.T) []byte {
	t.Helper()
	var base bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 800, 800))
	require.NoError(t, jpeg.Encode(&base, img, nil))
	b := base.Bytes()

	// APP1 marker, length, "Exif\0\0", then a token standing in for GPS data.
	payload := append([]byte("Exif\x00\x00"), []byte("GPSLatitudeRefN")...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte((len(payload) + 2) & 0xFF)}
	seg = append(seg, payload...)

	out := append([]byte{}, b[:2]...) // SOI
	out = append(out, seg...)
	out = append(out, b[2:]...)
	return out
}
```

Imports needed: `encoding/binary`, `hash/crc32` alongside the rest.

- [ ] **Step 2: Run and watch it fail**

```bash
cd api && go test ./internal/imageproc/... -v
```

Expected: the package does not exist.

- [ ] **Step 3: Move the two primitives out of `bodyread`**

Create `api/internal/imageproc/decode.go` by MOVING `maxDecodePixels` and
`declaredPixelsExceedCap` out of `api/internal/bodyread/downscale.go`, exported,
comments intact:

```go
// Package imageproc holds the image primitives shared by every caller that
// accepts a user-supplied picture. It exists because there is now more than
// one: body-composition screenshots (internal/bodyread) and profile pictures
// (internal/identity). Two copies of a security guard is one copy that gets
// fixed.
package imageproc

import (
	"bytes"
	"image"
)

// MaxDecodePixels bounds the pixel count image.Decode is allowed to allocate,
// checked via the cheap image.DecodeConfig header read BEFORE the real decode
// ever runs. This is a SECURITY guard, not an optimization: an 8 MiB byte cap
// bounds the ENCODED size on the wire, but a crafted PNG can declare enormous
// pixel dimensions in a few header bytes while staying well under that cap --
// image.Decode allocates the FULL pixel buffer for whatever dimensions the
// header claims, so without this check an authenticated user could OOM the pod
// with one upload that passes every existing size check. 50,000,000 px
// (~7071x7071) is far larger than any real photo or screenshot while staying a
// small, bounded allocation.
const MaxDecodePixels = 50_000_000

// DeclaredPixelsExceedCap reports whether data's HEADER ALONE (read via the
// cheap image.DecodeConfig, which never allocates a pixel buffer) declares more
// pixels than MaxDecodePixels allows. It is its own function so it can be
// exercised directly against a crafted header -- proving the CAP COMPARISON
// fires, independent of what a caller's decode-failure path would otherwise do
// with the same bytes, which is how a missing guard hides.
//
// A header that fails to decode at all is NOT treated as exceeding the cap;
// that is the caller's decode-failure path to handle.
func DeclaredPixelsExceedCap(data []byte) bool {
	cfg, _, cfgErr := image.DecodeConfig(bytes.NewReader(data))
	if cfgErr != nil {
		return false
	}
	return int64(cfg.Width)*int64(cfg.Height) > MaxDecodePixels
}
```

Create `api/internal/imageproc/resize.go` by MOVING `boxAverageResize` across
verbatim, exported as `BoxAverageResize`, keeping its whole comment — including
the kora#365 history about why point sampling was wrong.

- [ ] **Step 4: Write the avatar normaliser**

Create `api/internal/imageproc/avatar.go`:

```go
package imageproc

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png" // format registration for image.Decode

	_ "golang.org/x/image/webp" // DO NOT ADD: see the note in NormalizeAvatar
)

const (
	// AvatarDimension is the stored square edge. 512 is four times the largest
	// on-screen size (72pt on profile, at 3x) so the picture stays sharp on a
	// Pro Max without storing a photograph.
	AvatarDimension = 512

	// MaxAvatarBytes matches the cap internal/bodyread/handler.go already
	// enforces, so the two upload paths refuse at the same size.
	MaxAvatarBytes = 8 << 20
)

var (
	ErrUnreadableImage = errors.New("imageproc: not a readable image")
	ErrImageTooLarge   = errors.New("imageproc: image is too large")
)

// NormalizeAvatar turns arbitrary user-supplied image bytes into a square JPEG
// of at most AvatarDimension on a side.
//
// Order matters and must not be tidied:
//
//  1. Byte cap, before anything reads the bytes.
//  2. HEADER-ONLY pixel cap, before image.Decode allocates for whatever
//     dimensions the header claims. See DeclaredPixelsExceedCap.
//  3. Centre-crop to square, so a face is cropped rather than squashed.
//  4. Box-average downscale. NOT nearest-neighbour, and NOT x/image/draw:
//     BoxAverageResize maps each destination pixel to the average of the source
//     rectangle it covers, which IS area resampling -- the right filter for a
//     large reduction of a photograph, and the one this repo already chose in
//     kora#365. x/image is not needed and is not added.
//  5. Re-encode as JPEG. This is HOW EXIF goes away, including the GPS
//     coordinates a selfie carries: re-encoding from pixels drops everything
//     that is not pixels, which is strictly more robust than removing the
//     metadata fields someone remembered to name.
//
// Unlike bodyread's downscaleForProvider, a failure here is FATAL rather than a
// fall back to the original bytes. There, downscaling is a cost optimisation
// and the original still works. Here, "return the original" would store an
// un-normalised, EXIF-carrying, arbitrarily large file -- the exact object this
// function exists to prevent.
func NormalizeAvatar(data []byte) ([]byte, error) {
	if len(data) > MaxAvatarBytes {
		return nil, ErrImageTooLarge
	}
	if DeclaredPixelsExceedCap(data) {
		return nil, ErrImageTooLarge
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, ErrUnreadableImage
	}

	square := centreCrop(img)
	edge := square.Bounds().Dx()
	if edge > AvatarDimension {
		square = BoxAverageResize(square, AvatarDimension, AvatarDimension)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, square, &jpeg.Options{Quality: 85}); err != nil {
		return nil, ErrUnreadableImage
	}
	return buf.Bytes(), nil
}

// centreCrop returns the largest centred square of img. Cropping rather than
// scaling both axes independently: every call site renders the result in a
// circle, and a squashed face in a 30px circle is worse than a tighter crop.
func centreCrop(img image.Image) image.Image {
	b := img.Bounds()
	edge := b.Dx()
	if b.Dy() < edge {
		edge = b.Dy()
	}
	x0 := b.Min.X + (b.Dx()-edge)/2
	y0 := b.Min.Y + (b.Dy()-edge)/2
	rect := image.Rect(x0, y0, x0+edge, y0+edge)

	type subImager interface{ SubImage(image.Rectangle) image.Image }
	if si, ok := img.(subImager); ok {
		return si.SubImage(rect)
	}
	// Not every image.Image exposes SubImage; copy through BoxAverageResize at
	// 1:1, which is a no-op average over single-pixel boxes.
	return BoxAverageResize(img, edge, edge)
}
```

**Delete the `_ "golang.org/x/image/webp"` import line above before compiling.**
It is written in only to be deleted: WebP support is a new dependency, this task
does not add one, and the two formats the mobile picker produces are JPEG and
PNG (the same pair `bodyread/downscale.go` documents against
`apps/mobile`'s image-picker mime types).

- [ ] **Step 5: Point `bodyread` at the shared package and delete the stale comment**

In `api/internal/bodyread/downscale.go`:

1. **Delete the entire package doc comment** (the `WHY NOT golang.org/x/image/draw`
   block). It describes nearest-neighbour, which this file stopped doing in
   kora#365, and it is what the #449 spec and issue were both written from.
   Replace it with:

```go
// downscale.go shrinks an oversized body-composition screenshot before it is
// sent to a vision provider. The pixel cap and the resampler both live in
// internal/imageproc, shared with avatar normalisation -- see kora#365 for why
// this file averages rather than point-samples, and kora#449 for why a second
// caller made them shared.
```

2. Delete `maxDecodePixels`, `declaredPixelsExceedCap` and `boxAverageResize`
   from this file, and call `imageproc.DeclaredPixelsExceedCap(data)` and
   `imageproc.BoxAverageResize(img, newWidth, newHeight)` instead. Keep
   `maxDimension` and `downscaleJPEGQuality` here — they are this caller's
   policy, not shared primitives.

3. Any `bodyread` test that referenced the unexported names now references the
   `imageproc` ones, or moves to `imageproc`'s own test file. Do not delete a
   test to make this compile.

- [ ] **Step 6: Run everything that could have been broken by the move**

```bash
cd api && go test ./internal/imageproc/... ./internal/bodyread/... -v
go build ./...
```

Expected: PASS. `bodyread`'s existing decode-bomb test must still pass — if it
was deleted rather than repointed, put it back.

- [ ] **Step 7: Mutation-check**

Copy `avatar.go` to `/tmp`.

1. Move the `DeclaredPixelsExceedCap` check to AFTER `image.Decode`.
   `TestNormalizeAvatar_RejectsADecodeBombHeader` should still fail the test —
   confirm it does, and note that this mutation is the whole point of the guard:
   an implementation that checks after the allocation is the vulnerable one.
2. Replace `centreCrop` with a plain `BoxAverageResize(img, 512, 512)`.
   `TestNormalizeAvatar_DoesNotUpscale` must FAIL.
3. Replace the JPEG re-encode with returning `data` unchanged when the input is
   already small enough. `TestNormalizeAvatar_OutputCarriesNoEXIF` must FAIL.
   This is the one that matters: it is the difference between removing GPS
   coordinates and believing you did.
4. Restore and confirm green.

- [ ] **Step 8: Commit**

```bash
cd api && git add internal/imageproc/ internal/bodyread/
git commit -m "feat(imageproc): share the decode cap and resampler, add avatar normalisation (#449)"
```

---

### Task 7: Object storage

Kora persists no user images today — meal photos go to the vision provider as
base64 and are never stored. This task gives that posture up, deliberately, and
the code should say so where someone will read it.

**Files:**
- Create: `api/internal/assets/store.go`
- Create: `api/internal/assets/gcs.go`
- Create: `api/internal/assets/local.go`
- Modify: `api/internal/config/config.go`
- Modify: `api/cmd/api/main.go`
- Test: `api/internal/assets/local_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Store interface { Put(ctx, path string, data []byte, contentType string) error; Delete(ctx, path string) error; URL(path string) string }`
  - `func NewGCS(ctx context.Context, bucket, publicBaseURL string) (Store, error)`
  - `func NewLocal(dir, publicBaseURL string) Store`
  - `type Noop struct{}` implementing `Store`
  - `func AvatarPath(userID uuid.UUID) string`
  - Config fields `AssetsBucket`, `AssetsPublicBaseURL`, `AssetsLocalDir`

- [ ] **Step 1: Write the failing test**

Create `api/internal/assets/local_test.go`:

```go
package assets

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestLocal_PutThenReadBack(t *testing.T) {
	dir := t.TempDir()
	s := NewLocal(dir, "http://localhost:8080/assets")
	path := "avatars/" + uuid.NewString() + "/v1.jpg"

	require.NoError(t, s.Put(context.Background(), path, []byte("bytes"), "image/jpeg"))

	got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
	require.NoError(t, err)
	require.Equal(t, "bytes", string(got))
	require.Equal(t, "http://localhost:8080/assets/"+path, s.URL(path))
}

func TestLocal_DeleteIsIdempotent(t *testing.T) {
	s := NewLocal(t.TempDir(), "http://x/assets")
	path := "avatars/a/v1.jpg"
	require.NoError(t, s.Put(context.Background(), path, []byte("x"), "image/jpeg"))
	require.NoError(t, s.Delete(context.Background(), path))
	require.NoError(t, s.Delete(context.Background(), path),
		"deleting an object that is already gone is the outcome the caller asked for")
}

// An empty path must never compose a URL. It is the "this user has no picture"
// value, and a URL pointing at the bucket root renders as a broken image inside
// a friend row rather than falling back to initials.
func TestURL_EmptyPathIsEmptyURL(t *testing.T) {
	require.Empty(t, NewLocal(t.TempDir(), "http://x/assets").URL(""))
	require.Empty(t, Noop{}.URL("avatars/a/v1.jpg"))
}

// Path traversal. The path segment is composed by AvatarPath from a UUID today,
// but a store that joins caller-supplied text into a filesystem path must
// refuse to escape its directory regardless of who is calling.
func TestLocal_RefusesPathTraversal(t *testing.T) {
	dir := t.TempDir()
	s := NewLocal(dir, "http://x/assets")
	err := s.Put(context.Background(), "../../escaped.jpg", []byte("x"), "image/jpeg")
	require.Error(t, err)

	_, statErr := os.Stat(filepath.Join(filepath.Dir(dir), "escaped.jpg"))
	require.True(t, os.IsNotExist(statErr), "nothing may be written outside the store's directory")
}

// The version segment is what makes cache invalidation free: a new picture is a
// new URL, so no client, CDN or image cache anywhere has to be told to forget
// the old one.
func TestAvatarPath_IsVersionedPerUser(t *testing.T) {
	id := uuid.New()
	a, b := AvatarPath(id), AvatarPath(id)
	require.NotEqual(t, a, b, "each write gets its own path")
	require.True(t, strings.HasPrefix(a, "avatars/"+id.String()+"/"))
	require.True(t, strings.HasSuffix(a, ".jpg"))
}

func TestNoop_SucceedsSilently(t *testing.T) {
	require.NoError(t, Noop{}.Put(context.Background(), "p", []byte("x"), "image/jpeg"))
	require.NoError(t, Noop{}.Delete(context.Background(), "p"))
}
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd api && go test ./internal/assets/... -v
```

Expected: the package does not exist.

- [ ] **Step 3: Write the interface and the paths**

Create `api/internal/assets/store.go`:

```go
// Package assets stores user-supplied files.
//
// It is worth naming what this package changes: before it, Kora persisted NO
// user images at all -- meal photos are sent to the vision provider as base64
// and never written anywhere. Profile pictures (kora#449) give that posture up
// on purpose, in exchange for people being able to tell they found the right
// human before sending a friend request that may end in sharing body metrics.
// Anything added here should be weighed against that trade, not waved through
// because the package already exists.
package assets

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

type Store interface {
	Put(ctx context.Context, path string, data []byte, contentType string) error
	Delete(ctx context.Context, path string) error
	// URL composes the public URL for a stored path. It returns "" for an
	// empty path, which is what "this user has no picture" looks like.
	URL(path string) string
}

// AvatarPath is where one user's picture lives. The VERSION segment is a fresh
// UUID per write, which makes cache invalidation free: a new picture is a new
// URL, so no client, CDN or image cache has to be told to forget the old one.
// It also lets a lifecycle rule reap superseded objects without knowing
// anything about users.
//
// Objects are public-read at an unguessable path. Signed URLs were rejected:
// they would mean re-signing on every render of every friend row for no privacy
// gain, because the avatar is already visible to anyone holding the handle --
// that IS the consent boundary this feature is built on.
func AvatarPath(userID uuid.UUID) string {
	return "avatars/" + userID.String() + "/" + uuid.NewString() + ".jpg"
}

// Noop is the store used when no bucket is configured. Put and Delete succeed
// and URL returns "", so an environment with no object storage behaves exactly
// like every user having no picture -- rather than 500ing on upload, which
// would break local development for everyone not working on avatars.
type Noop struct{}

func (Noop) Put(context.Context, string, []byte, string) error { return nil }
func (Noop) Delete(context.Context, string) error              { return nil }
func (Noop) URL(string) string                                 { return "" }

// joinPublic composes publicBaseURL and path with exactly one slash between.
func joinPublic(base, path string) string {
	if path == "" || base == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}
```

- [ ] **Step 4: Write the local store**

Create `api/internal/assets/local.go`:

```go
package assets

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Local writes objects to the filesystem. It exists so the avatar path can be
// exercised end to end -- in tests and on a laptop -- without GCS credentials,
// and so a missing bucket is a configuration difference rather than a code path
// that only ever runs in production.
type Local struct {
	dir           string
	publicBaseURL string
}

func NewLocal(dir, publicBaseURL string) Store {
	return Local{dir: dir, publicBaseURL: publicBaseURL}
}

func (l Local) Put(_ context.Context, path string, data []byte, _ string) error {
	full, err := l.resolve(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fmt.Errorf("assets: create dir: %w", err)
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		return fmt.Errorf("assets: write object: %w", err)
	}
	return nil
}

func (l Local) Delete(_ context.Context, path string) error {
	full, err := l.resolve(path)
	if err != nil {
		return err
	}
	// Already gone is the outcome the caller asked for.
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("assets: delete object: %w", err)
	}
	return nil
}

func (l Local) URL(path string) string { return joinPublic(l.publicBaseURL, path) }

// resolve refuses any path that would escape the store's directory. Today's
// only caller composes paths from a UUID, so nothing can traverse -- but a
// store that joins text into a filesystem path and trusts its callers is one
// careless caller away from writing anywhere the process can.
func (l Local) resolve(path string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(path))
	if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
		return "", fmt.Errorf("assets: refusing path outside the store: %q", path)
	}
	full := filepath.Join(l.dir, clean)
	rel, err := filepath.Rel(l.dir, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("assets: refusing path outside the store: %q", path)
	}
	return full, nil
}
```

- [ ] **Step 5: Write the GCS store**

`cloud.google.com/go/storage` is already in `go.mod` as an **indirect**
dependency (v1.62.1, pulled in by `firebase.google.com/go/v4`). Importing it
promotes it to direct; `go mod tidy` moves the line out of the indirect block.
No new module is downloaded.

Create `api/internal/assets/gcs.go`:

```go
package assets

import (
	"context"
	"errors"
	"fmt"

	"cloud.google.com/go/storage"
)

// GCS stores objects in a Cloud Storage bucket. Authentication is Application
// Default Credentials -- the same mechanism firebase.NewApp already relies on
// in internal/auth/verifier.go, so a pod that can verify a token can also write
// an object, with no second credential to manage.
type GCS struct {
	client        *storage.Client
	bucket        string
	publicBaseURL string
}

func NewGCS(ctx context.Context, bucket, publicBaseURL string) (Store, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("assets: gcs client: %w", err)
	}
	return GCS{client: client, bucket: bucket, publicBaseURL: publicBaseURL}, nil
}

func (g GCS) Put(ctx context.Context, path string, data []byte, contentType string) error {
	w := g.client.Bucket(g.bucket).Object(path).NewWriter(ctx)
	w.ContentType = contentType
	// A superseded object is reaped by a lifecycle rule, never overwritten:
	// AvatarPath issues a fresh version per write, so a Put never targets an
	// existing object and CacheControl can be immutable.
	w.CacheControl = "public, max-age=31536000, immutable"
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return fmt.Errorf("assets: write object: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("assets: close object: %w", err)
	}
	return nil
}

func (g GCS) Delete(ctx context.Context, path string) error {
	err := g.client.Bucket(g.bucket).Object(path).Delete(ctx)
	if err != nil && !errors.Is(err, storage.ErrObjectNotExist) {
		return fmt.Errorf("assets: delete object: %w", err)
	}
	return nil
}

func (g GCS) URL(path string) string { return joinPublic(g.publicBaseURL, path) }
```

- [ ] **Step 6: Config and wiring**

In `api/internal/config/config.go`, add to the `Config` struct:

```go
	// Object storage for user-supplied assets (kora#449). Empty AssetsBucket
	// selects assets.Noop -- an environment with no bucket behaves as if every
	// user has no picture, rather than failing uploads, so nobody working on
	// anything else needs GCS credentials.
	AssetsBucket        string
	AssetsPublicBaseURL string
	AssetsLocalDir      string
```

and to `Load()`:

```go
		AssetsBucket:             os.Getenv("ASSETS_BUCKET"),
		AssetsPublicBaseURL:      os.Getenv("ASSETS_PUBLIC_BASE_URL"),
		AssetsLocalDir:           os.Getenv("ASSETS_LOCAL_DIR"),
```

In `api/cmd/api/main.go`, alongside the existing Redis block (~line 375), add:

```go
	// Precedence: a real bucket, else a local directory for laptop work, else
	// Noop. Never a nil Store -- router.go must not have to nil-check it, the
	// same reasoning the bodyread.NoCache{} wiring already follows.
	var assetStore assets.Store = assets.Noop{}
	switch {
	case cfg.AssetsBucket != "":
		s, err := assets.NewGCS(context.Background(), cfg.AssetsBucket, cfg.AssetsPublicBaseURL)
		if err != nil {
			// Non-fatal: an API that will not start because object storage is
			// unreachable takes down food logging with it. Avatars degrade to
			// "nobody has a picture"; everything else is unaffected.
			slog.Error("assets: gcs unavailable; profile pictures disabled", "error", err)
		} else {
			assetStore = s
		}
	case cfg.AssetsLocalDir != "":
		assetStore = assets.NewLocal(cfg.AssetsLocalDir, cfg.AssetsPublicBaseURL)
	}
```

Pass `assetStore` through to `server.Deps` (add an `Assets assets.Store` field
next to the existing cache fields) and default a nil value to `assets.Noop{}` in
`router.go` where the other NoCache defaults are applied (~line 489).

- [ ] **Step 7: Run the tests**

```bash
cd api && go mod tidy && go test ./internal/assets/... -v && go build ./...
```

Expected: PASS. Confirm `go.mod` now lists `cloud.google.com/go/storage` in the
direct block, and that `go mod tidy` did not add anything else — if it wants a
new module, something imported more than intended.

- [ ] **Step 8: Mutation-check**

Copy `local.go` to `/tmp`. Replace `resolve` with a plain
`filepath.Join(l.dir, path)`. `TestLocal_RefusesPathTraversal` must FAIL, and
check the filesystem afterwards to confirm a file really did land outside the
temp dir — then delete it. Restore.

- [ ] **Step 9: Commit**

```bash
cd api && git add internal/assets/ internal/config/config.go cmd/api/main.go internal/server/router.go go.mod go.sum
git commit -m "feat(assets): object storage with GCS, local and noop stores (#449)"
```

- [ ] **Step 10: Record the infrastructure that does not exist yet**

The bucket is **not** in this repo — Kora's Kubernetes manifests live in
`tesserix-infra`, and nothing here can create it. Do not treat this task as done
without writing the requirement down where the person doing the infra work will
find it. Append to `docs/OPEN_QUESTIONS.md`:

```markdown
## kora#449 — the assets bucket does not exist yet

Profile pictures need a bucket that has never been created:

- **Name**: `kora-prod-assets-in`, region `asia-south1` — matching the
  `<app>-<scope>-assets` convention of sibling apps and the Cloud SQL region.
- **Access**: public read on objects. Paths are unguessable (a v4 UUID version
  segment), and the picture is already visible to anyone holding the handle,
  which is the consent boundary the whole feature rests on. Signed URLs would
  mean re-signing on every render of every friend row for no privacy gain.
- **Lifecycle**: reap `avatars/**` objects that are not the current version.
  Each write issues a new path, so superseded objects accumulate otherwise.
- **Identity**: the `kora-api` workload identity service account needs
  `roles/storage.objectAdmin` scoped to this bucket, not project-wide.
- **Env on the deployment**: `ASSETS_BUCKET=kora-prod-assets-in`,
  `ASSETS_PUBLIC_BASE_URL=https://storage.googleapis.com/kora-prod-assets-in`.

Until all of that exists, `ASSETS_BUCKET` is unset in every environment,
`assets.Noop` is selected, and uploads silently succeed while every avatar URL
is empty. **That is the state to expect on first deploy** — it is not a bug, and
it is why the mobile client must treat an empty `avatar_url` as "no picture"
rather than as a failure.
```

```bash
git add docs/OPEN_QUESTIONS.md
git commit -m "docs: record the assets bucket kora#449 needs and does not have"
```

---

### Task 8: The avatar endpoints

`PUT /v1/me/avatar` (multipart) and `DELETE /v1/me/avatar`. This task also
replaces the `func(string) string { return "" }` placeholder wired in Task 5
with the real URL composer, so lookup starts returning pictures.

**Files:**
- Create: `api/internal/identity/avatar_handler.go`
- Modify: `api/internal/identity/repository.go` (add `SetAvatarPath`)
- Modify: `api/internal/identity/service.go` (add `SetAvatar`, `ClearAvatar`)
- Modify: `api/internal/server/router.go`
- Test: `api/internal/identity/avatar_test.go`

**Interfaces:**
- Consumes: `imageproc.NormalizeAvatar` (Task 6), `assets.Store`,
  `assets.AvatarPath` (Task 7).
- Produces:
  - `func (r Repository) SetAvatarPath(ctx, id uuid.UUID, path string) error`
  - `func (s Service) SetAvatar(ctx, userID uuid.UUID, data []byte) (string, error)` — returns the URL
  - `func (s Service) ClearAvatar(ctx, userID uuid.UUID) error`
  - `func NewServiceWithAssets(repo Repository, store assets.Store) Service`
  - `Handler.SetAvatar`, `Handler.ClearAvatar`

- [ ] **Step 1: Write the failing test**

Create `api/internal/identity/avatar_test.go`:

```go
package identity

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/assets"
	"github.com/tesserix/kora/api/internal/user"
)

func pngUpload(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func multipartBody(t *testing.T, field, filename string, data []byte) (string, *bytes.Buffer) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile(field, filename)
	require.NoError(t, err)
	_, err = part.Write(data)
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	return mw.FormDataContentType(), &body
}

func avatarEngine(t *testing.T, db *gorm.DB, store assets.Store, as uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewHandler(NewServiceWithAssets(NewRepository(db), store))
	r := gin.New()
	r.Use(func(c *gin.Context) { user.SetIDForTest(c, as); c.Next() })
	r.PUT("/v1/me/avatar", h.SetAvatar)
	r.DELETE("/v1/me/avatar", h.ClearAvatar)
	r.GET("/v1/users/lookup", h.Lookup)
	return r
}

func TestAvatar_UploadStoresANormalisedObjectAndReturnsAURL(t *testing.T) {
	db := testDB(t)
	dir := t.TempDir()
	store := assets.NewLocal(dir, "http://localhost:8080/assets")
	id := seedUser(t, db)
	r := avatarEngine(t, db, store, id)

	ct, body := multipartBody(t, "file", "selfie.png", pngUpload(t, 1400, 900))
	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())

	var path string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&path).Error)
	require.NotEmpty(t, path)
	require.Contains(t, rec.Body.String(), store.URL(path))

	// The object on disk is a square JPEG, not the PNG that was uploaded.
	stored, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
	require.NoError(t, err)
	cfg, format, err := image.DecodeConfig(bytes.NewReader(stored))
	require.NoError(t, err)
	require.Equal(t, "jpeg", format)
	require.Equal(t, cfg.Width, cfg.Height)
}

// Replacing a picture must not leave the old object behind. Every write issues
// a new path, so without an explicit delete the bucket accumulates every
// picture every user ever had — including ones they replaced deliberately.
func TestAvatar_ReplacingDeletesThePreviousObject(t *testing.T) {
	db := testDB(t)
	dir := t.TempDir()
	store := assets.NewLocal(dir, "http://x/assets")
	id := seedUser(t, db)
	svc := NewServiceWithAssets(NewRepository(db), store)

	_, err := svc.SetAvatar(context.Background(), id, pngUpload(t, 600, 600))
	require.NoError(t, err)
	var first string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&first).Error)

	_, err = svc.SetAvatar(context.Background(), id, pngUpload(t, 700, 700))
	require.NoError(t, err)
	var second string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&second).Error)

	require.NotEqual(t, first, second)
	_, statErr := os.Stat(filepath.Join(dir, filepath.FromSlash(first)))
	require.True(t, os.IsNotExist(statErr), "the superseded object must be gone")
}

func TestAvatar_ClearRemovesBothTheRowValueAndTheObject(t *testing.T) {
	db := testDB(t)
	dir := t.TempDir()
	store := assets.NewLocal(dir, "http://x/assets")
	id := seedUser(t, db)
	svc := NewServiceWithAssets(NewRepository(db), store)

	_, err := svc.SetAvatar(context.Background(), id, pngUpload(t, 600, 600))
	require.NoError(t, err)
	var path string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&path).Error)

	require.NoError(t, svc.ClearAvatar(context.Background(), id))

	var after *string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&after).Error)
	require.True(t, after == nil || *after == "")
	_, statErr := os.Stat(filepath.Join(dir, filepath.FromSlash(path)))
	require.True(t, os.IsNotExist(statErr))
}

func TestAvatar_RejectsBytesThatAreNotAnImage(t *testing.T) {
	db := testDB(t)
	r := avatarEngine(t, db, assets.NewLocal(t.TempDir(), "http://x"), seedUser(t, db))
	ct, body := multipartBody(t, "file", "notes.txt", []byte("this is not an image"))
	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 400, rec.Code)
}

func TestAvatar_MissingFilePartIs400(t *testing.T) {
	db := testDB(t)
	r := avatarEngine(t, db, assets.NewLocal(t.TempDir(), "http://x"), seedUser(t, db))
	req := httptest.NewRequest(http.MethodPut, "/v1/me/avatar", bytes.NewReader(nil))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=nope")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 400, rec.Code)
}

// With no bucket configured (assets.Noop), an upload must still SUCCEED and
// simply produce no picture — the first-deploy state described in
// docs/OPEN_QUESTIONS.md. A 500 here would break the profile screen in every
// environment that has no bucket.
func TestAvatar_NoopStoreSucceedsWithNoURL(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	url, err := NewServiceWithAssets(NewRepository(db), assets.Noop{}).
		SetAvatar(context.Background(), id, pngUpload(t, 600, 600))
	require.NoError(t, err)
	require.Empty(t, url)
}
```

Imports also needed: `os`, `path/filepath`.

- [ ] **Step 2: Run and watch it fail**

```bash
cd api && go test ./internal/identity/... -run TestAvatar -p 1 -v
```

Expected: compile failure — `undefined: NewServiceWithAssets`.

- [ ] **Step 3: Extend the repository and service**

Add to `api/internal/identity/repository.go`:

```go
// SetAvatarPath writes the new object path, or NULL to clear it.
func (r Repository) SetAvatarPath(ctx context.Context, id uuid.UUID, path string) error {
	var value any
	if path != "" {
		value = path
	}
	out := r.db.WithContext(ctx).Exec(`UPDATE users SET avatar_path = ? WHERE id = ?`, value, id)
	if out.Error != nil {
		return fmt.Errorf("identity: set avatar path: %w", out.Error)
	}
	if out.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
```

In `api/internal/identity/service.go`, replace the `avatarURL func` field with a
store, keeping `NewService` for the tests that supply a plain composer:

```go
type Service struct {
	repo      Repository
	avatarURL func(path string) string
	store     assets.Store
}

// NewService takes a bare URL composer, for callers and tests that do not need
// to write objects. Its store is assets.Noop{}, so SetAvatar succeeds and
// produces no picture rather than panicking on a nil interface.
func NewService(repo Repository, avatarURL func(path string) string) Service {
	return Service{repo: repo, avatarURL: avatarURL, store: assets.Noop{}}
}

// NewServiceWithAssets is the wiring the real API uses: one store supplies both
// the writes and the URL composition, so the two can never disagree about where
// an object lives.
func NewServiceWithAssets(repo Repository, store assets.Store) Service {
	if store == nil {
		store = assets.Noop{}
	}
	return Service{repo: repo, avatarURL: store.URL, store: store}
}

// SetAvatar normalises data, stores it at a fresh path, points the user row at
// it, and deletes whatever object it replaced.
//
// ORDER is load-bearing. The new object is written BEFORE the row is updated,
// so a failure between them leaves an orphaned object (reaped by the bucket's
// lifecycle rule) rather than a row pointing at nothing (a broken image in
// every friend row that renders this person). The OLD object is deleted LAST,
// and non-fatally: an upload that succeeded must not report failure because
// cleanup of a superseded file did not.
func (s Service) SetAvatar(ctx context.Context, userID uuid.UUID, data []byte) (string, error) {
	normalised, err := imageproc.NormalizeAvatar(data)
	if err != nil {
		return "", err
	}

	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}

	path := assets.AvatarPath(userID)
	if err := s.store.Put(ctx, path, normalised, "image/jpeg"); err != nil {
		return "", err
	}
	if err := s.repo.SetAvatarPath(ctx, userID, path); err != nil {
		return "", err
	}
	if me.AvatarPath != "" && me.AvatarPath != path {
		if err := s.store.Delete(ctx, me.AvatarPath); err != nil {
			slog.ErrorContext(ctx, "superseded avatar object survived; lifecycle rule will reap it",
				"user_id", userID, "path", me.AvatarPath, "error", err)
		}
	}
	return s.avatarURL(path), nil
}

// ClearAvatar removes the picture. The ROW is cleared first: if the object
// delete then fails, the user's picture is gone from every surface, which is
// what they asked for, and an unreferenced object is reaped by lifecycle. The
// reverse order would delete the object while the row still pointed at it --
// a broken image everywhere, on a request to remove one.
func (s Service) ClearAvatar(ctx context.Context, userID uuid.UUID) error {
	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return err
	}
	if me.AvatarPath == "" {
		return nil
	}
	if err := s.repo.SetAvatarPath(ctx, userID, ""); err != nil {
		return err
	}
	if err := s.store.Delete(ctx, me.AvatarPath); err != nil {
		slog.ErrorContext(ctx, "avatar object survived removal; lifecycle rule will reap it",
			"user_id", userID, "path", me.AvatarPath, "error", err)
	}
	return nil
}
```

Add `"log/slog"`, `"github.com/tesserix/kora/api/internal/assets"` and
`"github.com/tesserix/kora/api/internal/imageproc"` to the imports.

- [ ] **Step 4: Write the handler**

Create `api/internal/identity/avatar_handler.go`:

```go
package identity

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/imageproc"
)

// maxAvatarBodyBytes bounds the whole request body, which is larger than the
// image it carries: multipart adds a boundary, headers and a filename per part.
// Same headroom reasoning as internal/bodyread/handler.go, so a picture at
// exactly the image cap is not refused for its envelope.
const maxAvatarBodyBytes = imageproc.MaxAvatarBytes + (1 << 20)

// SetAvatar accepts a multipart "file" part.
//
// The upload goes through the API rather than direct-to-GCS with a signed URL,
// deliberately: the API MUST do the normalisation -- the pixel cap, the crop,
// the JPEG re-encode that removes GPS coordinates -- and a client cannot be
// trusted to have done it. A signed upload URL would let any client put any
// bytes in the bucket under its own name.
func (h Handler) SetAvatar(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}

	// Bound the raw body BEFORE multipart parsing, so an oversized upload is
	// refused without being buffered.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAvatarBodyBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "image_too_large",
				"That picture is too large. Pick one under 8 MB.")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "a 'file' part is required")
		return
	}

	f, err := fileHeader.Open()
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "couldn't read that file")
		return
	}
	defer f.Close()

	data, err := io.ReadAll(f) // bounded by MaxBytesReader above
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "couldn't read that file")
		return
	}

	url, err := h.svc.SetAvatar(c.Request.Context(), uid, data)
	if err != nil {
		switch {
		case errors.Is(err, imageproc.ErrImageTooLarge):
			httpx.Error(c, http.StatusRequestEntityTooLarge, "image_too_large",
				"That picture is too large. Pick one under 8 MB.")
		case errors.Is(err, imageproc.ErrUnreadableImage):
			httpx.Error(c, http.StatusBadRequest, "invalid_image",
				"That file isn't a picture Kora can read. Try a JPEG or PNG.")
		default:
			writeErr(c, err)
		}
		return
	}
	httpx.OK(c, gin.H{"avatar_url": url})
}

func (h Handler) ClearAvatar(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if err := h.svc.ClearAvatar(c.Request.Context(), uid); err != nil {
		writeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
```

- [ ] **Step 5: Replace the placeholder wiring**

In `api/internal/server/router.go`, change the identity block added in Task 5:

```go
		identityHandler := identity.NewHandler(
			identity.NewServiceWithAssets(identity.NewRepository(deps.DB), deps.Assets))
		v1.GET("/me/handle", identityHandler.GetHandle)
		v1.PUT("/me/handle", identityHandler.SetHandle)
		v1.DELETE("/me/handle", identityHandler.ClearHandle)
		v1.PUT("/me/avatar", identityHandler.SetAvatar)
		v1.DELETE("/me/avatar", identityHandler.ClearAvatar)
		v1.GET("/users/lookup",
			ratelimit.PerUser(identity.LookupLimit, identity.LookupPeriod),
			identityHandler.Lookup)
```

- [ ] **Step 6: Run everything**

```bash
cd api && go test ./internal/identity/... ./internal/server/... -p 1 -v && go build ./...
```

- [ ] **Step 7: Mutation-check**

Copy `service.go` to `/tmp`.

1. Delete the `s.store.Delete(ctx, me.AvatarPath)` call in `SetAvatar`.
   `TestAvatar_ReplacingDeletesThePreviousObject` must FAIL.
2. In `SetAvatar`, store `data` instead of `normalised`.
   `TestAvatar_UploadStoresANormalisedObjectAndReturnsAURL` must FAIL on the
   `"jpeg"` assertion. If it passes, the test is checking the response body
   rather than the stored object.
3. Restore and confirm green.

- [ ] **Step 8: Commit**

```bash
cd api && git add internal/identity/ internal/server/router.go
git commit -m "feat(identity): profile picture upload and removal, normalised through the API (#449)"
```

---

### Task 9: Account deletion removes the picture

`user.Service.Delete` exists so there is exactly one implementation of "erase
this person". The avatar object joins it there, not in a second place.

**Files:**
- Modify: `api/internal/user/deletion.go`
- Modify: `api/internal/server/router.go` (pass the store into `user.NewService`)
- Modify: `api/cmd/api/main.go` if it constructs the service directly
- Test: `api/internal/user/deletion_test.go`

**Interfaces:**
- Consumes: `assets.Store` (Task 7) — structurally, via a one-method interface.
- Produces: `type ObjectDeleter interface { Delete(ctx context.Context, path string) error }`;
  `NewService` gains a trailing `objects ObjectDeleter` parameter;
  `DeleteResult` gains `AvatarObjectRemoved bool`.

- [ ] **Step 1: Write the failing test**

Add to `api/internal/user/deletion_test.go`, following the fake style already in
that file (`fakeCacheEvicter` at line 43):

```go
type fakeObjectDeleter struct {
	deleted []string
	err     error
}

func (f *fakeObjectDeleter) Delete(_ context.Context, path string) error {
	f.deleted = append(f.deleted, path)
	return f.err
}

func TestDelete_RemovesTheAvatarObject(t *testing.T) {
	db := testDB(t)
	objects := &fakeObjectDeleter{}
	svc := newServiceForTest(t, db, objects) // see the existing constructor helper

	id := seedUserWithAvatar(t, db, "avatars/"+uuid.NewString()+"/v1.jpg")
	var path string
	require.NoError(t, db.Raw(`SELECT avatar_path FROM users WHERE id = ?`, id).Scan(&path).Error)

	res, err := svc.Delete(context.Background(), id, DeleteActor{})
	require.NoError(t, err)
	require.Equal(t, []string{path}, objects.deleted)
	require.True(t, res.AvatarObjectRemoved)
}

// A user with no picture must not produce a Delete call on an empty path — the
// GCS store would issue a request for the bucket root.
func TestDelete_WithNoAvatarTouchesNoObject(t *testing.T) {
	db := testDB(t)
	objects := &fakeObjectDeleter{}
	svc := newServiceForTest(t, db, objects)

	_, err := svc.Delete(context.Background(), seedUserForDeletion(t, db), DeleteActor{})
	require.NoError(t, err)
	require.Empty(t, objects.deleted)
}

// Object storage being unreachable must not block the deletion. Apple requires
// account deletion to complete in-app; a third-party outage cannot be what
// stops it. The result reports the object survived so it is visible rather
// than silent.
func TestDelete_ObjectFailureIsNonFatal(t *testing.T) {
	db := testDB(t)
	objects := &fakeObjectDeleter{err: errors.New("bucket unreachable")}
	svc := newServiceForTest(t, db, objects)

	id := seedUserWithAvatar(t, db, "avatars/"+uuid.NewString()+"/v1.jpg")
	res, err := svc.Delete(context.Background(), id, DeleteActor{})
	require.NoError(t, err, "the account must still be deleted")
	require.False(t, res.AvatarObjectRemoved)

	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, id).Scan(&n).Error)
	require.EqualValues(t, 0, n)
}

// A nil deleter is what a deployment with no bucket wires. Delete must degrade
// to "skip", exactly as it already does for a nil Apple client, not panic.
func TestDelete_NilObjectDeleterIsSkipped(t *testing.T) {
	db := testDB(t)
	svc := newServiceForTest(t, db, nil)
	id := seedUserWithAvatar(t, db, "avatars/"+uuid.NewString()+"/v1.jpg")
	res, err := svc.Delete(context.Background(), id, DeleteActor{})
	require.NoError(t, err)
	require.False(t, res.AvatarObjectRemoved)
}
```

Write `seedUserWithAvatar` next to the existing seed helper in that file; reuse
whatever the file already calls its service constructor rather than adding a
second one.

- [ ] **Step 2: Run and watch it fail**

```bash
cd api && go test ./internal/user/... -run TestDelete -p 1 -v
```

Expected: FAIL — `res.AvatarObjectRemoved` undefined.

- [ ] **Step 3: Implement**

In `api/internal/user/deletion.go`, add the consumer-declared interface next to
`CacheEvicter` and `IdentityDeleter`, following their comment style:

```go
// ObjectDeleter removes one stored object. Declared HERE, at the consumer, for
// the same reason CacheEvicter is: assets.Store satisfies it structurally at
// the wiring site, and a test fake needs no bucket.
//
// It may be nil. A deployment with no bucket configured wires nothing, and
// Delete must degrade to "skip the object" rather than panic -- the same
// treatment the nil Apple client already gets.
type ObjectDeleter interface {
	Delete(ctx context.Context, path string) error
}
```

Add the field to `Service`, the parameter to `NewService`, and to
`DeleteResult`:

```go
	// AvatarObjectRemoved is false when the DB delete succeeded but the stored
	// picture survived -- same reporting rule as FirebaseIdentityRemoved.
	AvatarObjectRemoved bool `json:"avatar_object_removed"`
```

Then extend `Delete`'s step list. Amend the ordering comment on `Delete` to add
a sixth step, and place the call **after** the transaction, next to the Redis
eviction:

```go
	// 6. Avatar object. AFTER the DB delete and non-fatal, for the same reason
	//    Apple revocation is non-fatal: Apple requires deletion to complete
	//    in-app, so a bucket outage cannot be what stops it. u.AvatarPath was
	//    read from the row up front -- like the Apple token and the Firebase
	//    uid, it stops existing the moment the DELETE lands.
	if u.AvatarPath != "" && s.objects != nil {
		if err := s.objects.Delete(ctx, u.AvatarPath); err != nil {
			slog.ErrorContext(ctx, "avatar object survived deletion; NEEDS MANUAL CLEANUP",
				"user_id", userID, "path", u.AvatarPath, "error", err)
		} else {
			res.AvatarObjectRemoved = true
		}
	}
```

Update every `user.NewService(...)` call site to pass the store (`deps.Assets`
in `router.go`), and every existing test that constructs the service to pass
`nil`.

- [ ] **Step 4: Run the tests**

```bash
cd api && go test ./internal/user/... ./internal/server/... -p 1 -v && go build ./...
```

- [ ] **Step 5: Mutation-check**

Copy `deletion.go` to `/tmp`. Move the object delete to BEFORE the transaction.
`TestDelete_ObjectFailureIsNonFatal` will still pass, which is the point worth
noticing: the ordering is not what that test guards. Instead, drop the
`u.AvatarPath != ""` condition — `TestDelete_WithNoAvatarTouchesNoObject` must
FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
cd api && git add internal/user/ internal/server/router.go cmd/api/main.go
git commit -m "feat(user): delete the avatar object as part of the account cascade (#449)"
```

---

### Task 10: Pictures in the surfaces that already show initials

The spec says the existing `Avatar` "gains a real image when present" across
Social, friends and circles. That requires the URL on the projections those
screens read — `social.FriendView` and `share.MemberView` — not only on lookup.

**Files:**
- Modify: `api/internal/social/model.go`, `api/internal/social/service.go`
- Modify: `api/internal/share/model.go`, `api/internal/share/repository.go`
- Test: `api/internal/social/service_test.go`, `api/internal/share/repository_test.go`

**Interfaces:**
- Consumes: `assets.Store.URL` (Task 7).
- Produces: `FriendView` gains `Handle string` and `AvatarURL string`;
  `MemberView` gains `AvatarURL string`. `social.NewService` and
  `share.NewRepository` each gain a trailing `avatarURL func(string) string`.

- [ ] **Step 1: Write the failing tests**

Add to `api/internal/social/service_test.go`:

```go
func TestListFriends_CarriesHandleAndAvatarButNeverEmail(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	them := seedUser(t, db, "Ada L")
	path := "avatars/" + them.String() + "/v1.jpg"
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = 'ada', handle_canonical = 'ada', avatar_path = ? WHERE id = ?`,
		path, them).Error)
	seedAcceptedFriendship(t, db, me, them)

	svc := NewService(NewRepository(db), user.NewRepository(db),
		func(p string) string {
			if p == "" {
				return ""
			}
			return "https://assets.test/" + p
		})

	got, err := svc.ListFriends(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "ada", got[0].Handle)
	require.Equal(t, "https://assets.test/"+path, got[0].AvatarURL)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, them).Scan(&email).Error)
	require.NotEmpty(t, email)
	body, err := json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(body), email)
	require.NotContains(t, string(body), "email")
}

// A friend with no picture must produce "" rather than a URL pointing at
// nothing — the client falls back to initials on empty, and renders a broken
// image on a URL that resolves to no object.
func TestListFriends_NoAvatarIsEmptyURL(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	them := seedUser(t, db, "No Picture")
	seedAcceptedFriendship(t, db, me, them)

	svc := NewService(NewRepository(db), user.NewRepository(db),
		func(p string) string { return "https://assets.test/" + p })

	got, err := svc.ListFriends(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Empty(t, got[0].AvatarURL)
}
```

`seedUser` and `seedAcceptedFriendship` already exist in this file under
whatever names it gave them — read it first and use those rather than
introducing a second seeding style. If the accepted-friendship helper does not
exist, write one next to `seedUser` rather than inlining the two INSERTs into
both tests.

Add the mirror in `api/internal/share/repository_test.go` for `MemberView`:

```go
func TestListMembers_CarriesAvatarURLButNeverEmail(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	path := "avatars/" + member.String() + "/v1.jpg"
	require.NoError(t, db.Exec(
		`UPDATE users SET avatar_path = ? WHERE id = ?`, path, member).Error)

	repo := NewRepository(db, func(p string) string {
		if p == "" {
			return ""
		}
		return "https://assets.test/" + p
	})
	circle, err := repo.Create(context.Background(), owner, "Close")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), circle.ID, member))

	circles, err := repo.ListForOwner(context.Background(), owner)
	require.NoError(t, err)
	require.Len(t, circles, 1)
	require.Len(t, circles[0].Members, 1)
	require.Equal(t, "https://assets.test/"+path, circles[0].Members[0].AvatarURL)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, member).Scan(&email).Error)
	body, err := json.Marshal(circles)
	require.NoError(t, err)
	require.NotContains(t, string(body), email)
}
```

Match the real names of `Create`, `AddMember` and `ListForOwner` against
`api/internal/share/repository.go` before writing this — they are what that file
already calls them, and a renamed method here is a compile error, not a
mismatch you find later.

- [ ] **Step 2: Run and watch them fail**

```bash
cd api && go test ./internal/social/... ./internal/share/... -p 1 -v
```

- [ ] **Step 3: Implement**

In `api/internal/social/model.go`:

```go
// FriendView is the public projection of a user — never exposes email.
//
// Handle and AvatarURL are here so a friend row can show a face and a sayable
// name rather than initials and a display name that is not unique. AvatarURL is
// "" for a user with no picture, which is what the client falls back to
// initials on.
type FriendView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Handle      string    `json:"handle"`
	AvatarURL   string    `json:"avatar_url"`
}
```

Add `AvatarURL string \`json:"avatar_url"\`` to `share.MemberView`. Thread an
`avatarURL func(string) string` into both constructors and populate the field
where each view is built. `MembershipView` gains **nothing** — it deliberately
carries no circle name, and the reason (a circle name is the owner's private
label) is unrelated to avatars but the same instinct applies: add only what the
member-side screen renders.

Wire the composer from `deps.Assets.URL` in `router.go`, and pass
`func(string) string { return "" }` in any test that does not care.

- [ ] **Step 4: Run and commit**

```bash
cd api && go test ./internal/social/... ./internal/share/... ./internal/server/... -p 1 && go build ./...
git add internal/social/ internal/share/ internal/server/router.go
git commit -m "feat(social): carry handle and avatar URL on the friend and member projections (#449)"
```

- [ ] **Step 5: Run the whole API suite before moving to the client**

```bash
cd api && go test ./... -p 1
```

Expected: PASS. Anything failing here is a regression from the ten tasks above,
not something the mobile work will reveal later.

---

## Phase C — the client

Two things about this repo before touching `apps/mobile`:

- **Never run prettier here.** There is no prettier config, and it has silently
  swallowed an edit before. Match surrounding style by hand.
- **`jest.mock` factories cannot reference out-of-scope variables** unless the
  name is prefixed `mock`. Name fixtures `mockLookup`, `mockHandle` etc., or the
  suite fails to parse with a confusing babel error.

### Task 11: `Avatar` renders a picture, and multipart can PUT

**Files:**
- Modify: `apps/mobile/src/components/Avatar.tsx`
- Modify: `apps/mobile/src/lib/api.ts:480`
- Test: `apps/mobile/src/components/__tests__/Avatar.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Avatar` props become `{ initials: string; size?: number; uri?: string | null }`
  - `apiFetchMultipart(path, form, init?)` where `init` gains
    `method?: "POST" | "PUT"`, defaulting to `"POST"`

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/components/__tests__/Avatar.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { Image } from "react-native";
import { Avatar } from "../Avatar";

describe("Avatar", () => {
  it("renders initials when there is no picture", () => {
    const { getByText, UNSAFE_queryAllByType } = render(<Avatar initials="AL" />);
    expect(getByText("AL")).toBeTruthy();
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(0);
  });

  // An empty string is what the API sends for "no picture" — it is not a URL,
  // and rendering it produces a broken image inside a friend row.
  it("falls back to initials for an empty uri", () => {
    const { getByText, UNSAFE_queryAllByType } = render(<Avatar initials="AL" uri="" />);
    expect(getByText("AL")).toBeTruthy();
    expect(UNSAFE_queryAllByType(Image)).toHaveLength(0);
  });

  it("falls back to initials for a null uri", () => {
    const { getByText } = render(<Avatar initials="AL" uri={null} />);
    expect(getByText("AL")).toBeTruthy();
  });

  it("renders the picture when there is one, and not the initials underneath", () => {
    const { queryByText, UNSAFE_getAllByType } = render(
      <Avatar initials="AL" uri="https://assets.test/avatars/a/v1.jpg" />,
    );
    const images = UNSAFE_getAllByType(Image);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({ uri: "https://assets.test/avatars/a/v1.jpg" });
    expect(queryByText("AL")).toBeNull();
  });

  // The circle is the identity chip's whole shape. A square photo inside it
  // would break every row it appears in.
  it("clips the picture to the circle at the requested size", () => {
    const { UNSAFE_getAllByType } = render(
      <Avatar initials="AL" size={72} uri="https://assets.test/a.jpg" />,
    );
    const style = UNSAFE_getAllByType(Image)[0].props.style;
    expect(style).toMatchObject({ width: 72, height: 72, borderRadius: 36 });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/mobile && npx jest src/components/__tests__/Avatar.test.tsx
```

Expected: FAIL — no `Image` is rendered.

- [ ] **Step 3: Implement**

In `apps/mobile/src/components/Avatar.tsx`, change the props and add the image
branch. Keep every existing comment — the `MAX_FONT_SCALE` reasoning about
kora#324 is still load-bearing for the initials path.

```tsx
type Props = { initials: string; size?: number; uri?: string | null };
```

and inside the component, before the `<AppText>`:

```tsx
  // An empty string is the API's "no picture" value, not a URL. Treating it as
  // one renders a broken image inside a friend row — worse than the initials
  // it replaced. Same for null, which is what a stale cache returns.
  const hasPicture = typeof uri === "string" && uri.length > 0;
```

then render, inside the same `<View>` that already draws the circle:

```tsx
      {hasPicture ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          accessible={false}
        />
      ) : (
        <AppText
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={{ fontSize: size * GLYPH_RATIO, fontWeight: "600", color: instrument.ink }}
        >
          {initials}
        </AppText>
      )}
```

`accessible={false}` because the picture is decorative for exactly the reason
the initials are: every call site wraps this in a control that carries its own
`accessibilityLabel`, so the image must not become the accessible name.

Import `Image` from `react-native` alongside `StyleSheet` and `View`.

- [ ] **Step 4: Add the method option to multipart**

In `apps/mobile/src/lib/api.ts`, change the `apiFetchMultipart` signature:

```ts
export async function apiFetchMultipart(
  path: string,
  form: FormData,
  // method defaults to POST so no existing caller changes. PUT is here for
  // /v1/me/avatar, which replaces a resource rather than creating one.
  init: { signal?: AbortSignal; method?: "POST" | "PUT" } = {},
): Promise<unknown> {
```

and inside, `method: init.method ?? "POST"`.

- [ ] **Step 5: Run the tests**

```bash
cd apps/mobile && npx jest src/components/__tests__/Avatar.test.tsx src/lib/__tests__/api.test.ts
```

Expected: PASS, including the existing api tests — the method default must not
have changed any current caller.

- [ ] **Step 6: Mutation-check**

Copy `Avatar.tsx` to `/tmp`. Change `hasPicture` to `uri != null`. The
empty-string test must FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/Avatar.tsx apps/mobile/src/components/__tests__/Avatar.test.tsx apps/mobile/src/lib/api.ts
git commit -m "feat(mobile): Avatar renders a picture, multipart can PUT (#449)"
```

---

### Task 12: Types and hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/identityHooks.test.tsx`

**Interfaces:**
- Consumes: the API from Tasks 5 and 8; `apiFetchMultipart` (Task 11).
- Produces:
  - `type LookupResult = { id: string; display_name: string; handle: string; avatar_url: string }`
  - `type MyHandle = { handle: string }`
  - `useLookupHandle()` — a **mutation**, not a query
  - `useMyHandle()`, `useSetHandle()`, `useClearHandle()`
  - `useUploadAvatar()`, `useDeleteAvatar()`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/api/__tests__/identityHooks.test.tsx`, following the
provider/wrapper setup in `apps/mobile/src/api/__tests__/hooks.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react-native";
import { useLookupHandle, useSetHandle, useUploadAvatar } from "../hooks";
import * as api from "@/lib/api";

jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiFetch: jest.fn(),
  apiFetchMultipart: jest.fn(),
}));

const mockFetch = api.apiFetch as jest.Mock;
const mockMultipart = api.apiFetchMultipart as jest.Mock;

beforeEach(() => {
  mockFetch.mockReset();
  mockMultipart.mockReset();
});

// Lookup is a MUTATION even though it reads. A useQuery keyed on the typed
// handle would fire a request on every keystroke — against the one endpoint in
// this API that is rate limited, and for a reason: it is what stands between
// exact-match lookup and enumeration.
it("looks a handle up only when asked", async () => {
  mockFetch.mockResolvedValue({ id: "u1", display_name: "Ada", handle: "ada", avatar_url: "" });
  const { result } = renderHook(() => useLookupHandle(), { wrapper });

  expect(mockFetch).not.toHaveBeenCalled();
  result.current.mutate("ada");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/users/lookup?handle=ada");
});

it("url-encodes the handle it looks up", async () => {
  mockFetch.mockResolvedValue({ id: "u1", display_name: "A", handle: "a_b", avatar_url: "" });
  const { result } = renderHook(() => useLookupHandle(), { wrapper });
  result.current.mutate("@a b");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/users/lookup?handle=%40a%20b");
});

it("sends a handle change as PUT and invalidates the cached handle", async () => {
  mockFetch.mockResolvedValue({ handle: "ada" });
  const { result } = renderHook(() => useSetHandle(), { wrapper });
  result.current.mutate("ada");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockFetch).toHaveBeenCalledWith("/v1/me/handle", {
    method: "PUT",
    body: JSON.stringify({ handle: "ada" }),
  });
});

// The avatar goes through apiFetchMultipart, never apiFetch: apiFetch forces
// Content-Type: application/json, which breaks the multipart boundary fetch()
// sets for a FormData body.
it("uploads the avatar as multipart PUT", async () => {
  mockMultipart.mockResolvedValue({ avatar_url: "https://assets.test/a.jpg" });
  const { result } = renderHook(() => useUploadAvatar(), { wrapper });
  const form = new FormData();
  result.current.mutate(form);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockMultipart).toHaveBeenCalledWith("/v1/me/avatar", form, { method: "PUT" });
  expect(mockFetch).not.toHaveBeenCalled();
});
```

Copy the `wrapper` (a `QueryClientProvider` with retries disabled) from
`hooks.test.tsx` rather than writing a second one.

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/mobile && npx jest src/api/__tests__/identityHooks.test.tsx
```

- [ ] **Step 3: Implement**

Add to `apps/mobile/src/api/types.ts`:

```ts
// The projection GET /v1/users/lookup returns. There is no listing form of
// that endpoint — exact match only — so there is no array type here either.
export type LookupResult = {
  id: string;
  display_name: string;
  handle: string;
  // "" when the person has no picture, and when no bucket is configured.
  // Treat it as "no picture", never as a failure.
  avatar_url: string;
};

export type MyHandle = { handle: string };
```

Add to `apps/mobile/src/api/hooks.ts`, near the friend-code hooks:

```ts
// Handles (kora#449). Lookup is a MUTATION despite reading: a query keyed on
// the typed text would fire on every keystroke against the one rate-limited
// endpoint in the API, and that limiter is what stands between exact-match
// lookup and enumeration. The user asks once, by pressing a button.
export function useLookupHandle() {
  return useMutation({
    mutationFn: (handle: string) =>
      apiFetch(`/v1/users/lookup?handle=${encodeURIComponent(handle)}`) as Promise<LookupResult>,
  });
}

export function useMyHandle() {
  return useQuery({
    queryKey: ["my-handle"],
    queryFn: () => apiFetch("/v1/me/handle") as Promise<MyHandle>,
  });
}

export function useSetHandle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) =>
      apiFetch("/v1/me/handle", {
        method: "PUT",
        body: JSON.stringify({ handle }),
      }) as Promise<MyHandle>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-handle"] });
    },
  });
}

export function useClearHandle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/me/handle", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-handle"] });
    },
  });
}

// Both avatar mutations invalidate every surface that renders a face: the
// profile itself, the friends list and the circles audit all read an
// avatar_url, and a stale one shows the old picture until the next cold start.
function invalidateAvatarSurfaces(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["me"] });
  qc.invalidateQueries({ queryKey: ["friends"] });
  qc.invalidateQueries({ queryKey: ["circles"] });
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) =>
      apiFetchMultipart("/v1/me/avatar", form, { method: "PUT" }) as Promise<{ avatar_url: string }>,
    onSuccess: () => invalidateAvatarSurfaces(qc),
  });
}

export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/me/avatar", { method: "DELETE" }),
    onSuccess: () => invalidateAvatarSurfaces(qc),
  });
}
```

Check the exact query keys used by the existing `me`, `friends` and `circles`
queries in this file before writing `invalidateAvatarSurfaces` — a key that does
not match invalidates nothing, silently.

- [ ] **Step 4: Run and commit**

```bash
cd apps/mobile && npx jest src/api && npx tsc --noEmit
git add apps/mobile/src/api/
git commit -m "feat(mobile): identity types and hooks for handle and avatar (#449)"
```

---

### Task 13: Add a friend, by handle

Handle becomes the primary field. Email and friend code stay as secondary paths
— existing `mobile://friend/<code>` links must keep working.

The lookup result is the screen the avatar exists for, so it has to get three
states right, and the third is the one that produced defects in kora#443:
**pending must never render as a claim about a person.** A card that says
"Ada Lovelace" while the request is still in flight is a factual assertion about
someone else's identity made from stale state.

**Files:**
- Create: `apps/mobile/src/components/social/LookupResultCard.tsx`
- Modify: `apps/mobile/src/components/social/AddFriendSheet.tsx`
- Test: `apps/mobile/src/components/social/__tests__/AddFriendSheet.test.tsx`

**Interfaces:**
- Consumes: `useLookupHandle`, `useSendFriendRequest`, `useMyFriendCode`
  (Task 12 and existing), `Avatar` (Task 11).
- Produces: `<LookupResultCard result={LookupResult} onSend={() => void} sending={boolean} />`

- [ ] **Step 1: Write the failing tests**

Add to `apps/mobile/src/components/social/__tests__/AddFriendSheet.test.tsx`
(read the existing file first — it already mocks the hooks, and those mock
factory variables must stay `mock`-prefixed):

```tsx
it("looks up a handle and shows the person before anything is sent", async () => {
  mockLookup.mockResolvedValue({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" });
  const { getByLabelText, getByText, queryByText } = render(<AddFriendSheet visible onClose={noop} />);

  fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  fireEvent.press(getByText("Find"));

  await waitFor(() => expect(getByText("Ada L")).toBeTruthy());
  expect(getByText("@ada")).toBeTruthy();
  expect(mockSendRequest).not.toHaveBeenCalled();
});

// The defect this prevents: a card rendering a previous result, or a
// half-populated one, while a request is still in flight — a factual claim
// about who someone is, made from state that is not an answer yet.
it("shows no person while the lookup is pending", async () => {
  let resolve: (v: unknown) => void = () => {};
  mockLookup.mockReturnValue(new Promise((r) => { resolve = r; }));
  const { getByLabelText, getByText, queryByText } = render(<AddFriendSheet visible onClose={noop} />);

  fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  fireEvent.press(getByText("Find"));

  expect(queryByText("Send request")).toBeNull();
  expect(getByText("Looking up…")).toBeTruthy();

  resolve({ id: "u1", display_name: "Ada L", handle: "ada", avatar_url: "" });
  await waitFor(() => expect(getByText("Ada L")).toBeTruthy());
});

// A miss and a success must not read alike. This is the 404-vs-200-with-empty
// failure from kora#443, in a new place.
it("says nobody has that handle on a miss, and offers nothing to send", async () => {
  mockLookup.mockRejectedValue(new ApiError(404, "not_found", "No Kora account has that handle."));
  const { getByLabelText, getByText, queryByText } = render(<AddFriendSheet visible onClose={noop} />);

  fireEvent.changeText(getByLabelText("Handle, email or friend code"), "nobody"), fireEvent.press(getByText("Find"));

  await waitFor(() => expect(getByText("No Kora account has that handle.")).toBeTruthy());
  expect(queryByText("Send request")).toBeNull();
});

it("tells the user plainly when they are looking up too fast", async () => {
  mockLookup.mockRejectedValue(new ApiError(429, "rate_limited", "Too many lookups. Try again in a minute."));
  const { getByLabelText, getByText } = render(<AddFriendSheet visible onClose={noop} />);
  fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  fireEvent.press(getByText("Find"));
  await waitFor(() => expect(getByText("Too many lookups. Try again in a minute.")).toBeTruthy());
});

// An email or a friend code must still work — every existing invite link is a
// friend code, and they cannot stop resolving because handles arrived.
it("still sends by email without a lookup", async () => {
  const { getByLabelText, getByText } = render(<AddFriendSheet visible onClose={noop} />);
  fireEvent.changeText(getByLabelText("Handle, email or friend code"), "someone@example.test");
  fireEvent.press(getByText("Find"));
  await waitFor(() => expect(mockSendRequest).toHaveBeenCalledWith({ email: "someone@example.test" }, expect.anything()));
  expect(mockLookup).not.toHaveBeenCalled();
});

// A blank display_name above "send them a request" is the kora#443 defect
// verbatim: a sentence about a person, with no person named.
it("falls back to the handle when the display name is blank", async () => {
  mockLookup.mockResolvedValue({ id: "u1", display_name: "", handle: "ada", avatar_url: "" });
  const { getByLabelText, getByText } = render(<AddFriendSheet visible onClose={noop} />);
  fireEvent.changeText(getByLabelText("Handle, email or friend code"), "ada");
  fireEvent.press(getByText("Find"));
  await waitFor(() => expect(getByText("@ada")).toBeTruthy());
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/mobile && npx jest src/components/social/__tests__/AddFriendSheet.test.tsx
```

- [ ] **Step 3: Write the result card**

Create `apps/mobile/src/components/social/LookupResultCard.tsx`:

```tsx
import { View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useTheme } from "@/theme";
import type { LookupResult } from "@/api/types";

// initials() mirrors app/profile.tsx's fallback so one person renders the same
// letters everywhere they appear without a picture.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

type Props = { result: LookupResult; onSend: () => void; sending: boolean };

// This is the screen the avatar exists for: the last surface before a request
// that may end in sharing body metrics. It renders ONLY a resolved result —
// the caller must not mount it while a lookup is pending, because a name shown
// mid-flight is a factual claim about someone made from state that is not an
// answer yet (kora#443).
export function LookupResultCard({ result, onSend, sending }: Props) {
  const { instrument, radius } = useTheme();
  // A display name can be blank. "@ada" is a true statement about this person;
  // an empty line above "Send request" is not.
  const name = result.display_name.trim() || "@" + result.handle;

  return (
    <View
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: radius.lg,
        backgroundColor: instrument.inset,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
      }}
    >
      <Avatar initials={initials(result.display_name) || "@"} size={48} uri={result.avatar_url} />
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink }}>{name}</AppText>
        {result.display_name.trim() ? (
          <AppText style={{ fontSize: 14, color: instrument.mut, marginTop: 2 }}>
            @{result.handle}
          </AppText>
        ) : null}
      </View>
      <Button title="Send request" onPress={onSend} disabled={sending} />
    </View>
  );
}
```

- [ ] **Step 4: Rework the sheet**

In `apps/mobile/src/components/social/AddFriendSheet.tsx`:

- Placeholder and `accessibilityLabel` become `"Handle, email or friend code"`.
- The button is `"Find"`, not `"Send request"` — the send moves onto the card.
- `onSubmit` routes on shape: a value containing `@` **after** stripping a
  leading `@` is an email and sends directly (preserving today's behaviour);
  anything else is a handle and goes to lookup.
- Hold `const [found, setFound] = useState<LookupResult | null>(null)`. Clear it
  in `onChangeText`, so editing the field can never leave a card describing the
  previous person on screen next to new text.
- Render exactly one of: the card (`found` and not pending), `"Looking up…"`
  (pending), the error text, or nothing.

The shape check:

```tsx
  const onSubmit = () => {
    const raw = value.trim();
    if (!raw) {
      setErr("Enter a handle, email or friend code.");
      return;
    }
    setErr(null);
    setFound(null);

    // A leading @ is how people write a handle, and stripping it BEFORE the
    // email test is what stops "@ada" being routed as an email.
    const v = raw.replace(/^@/, "");
    if (v.includes("@")) {
      send.mutate({ email: v }, { onSuccess: onClose, onError: showError });
      return;
    }
    lookup.mutate(v, { onSuccess: setFound, onError: showError });
  };
```

with

```tsx
  const showError = (e: unknown) => {
    // ApiError carries the server's message for 404 and 429 alike; both are
    // things the person can act on, so neither is replaced with a generic one.
    const msg = e instanceof Error ? e.message : "";
    setErr(msg || "Couldn't look that up. Try again.");
  };
```

Keep the "Your code" section exactly as it is. Friend codes are not being
retired — every `mobile://friend/<code>` link already in a message thread must
keep resolving.

- [ ] **Step 5: Run the tests**

```bash
cd apps/mobile && npx jest src/components/social && npx tsc --noEmit
```

- [ ] **Step 6: Mutation-check the two that guard something**

Copy `AddFriendSheet.tsx` to `/tmp`.

1. Delete the `setFound(null)` in `onChangeText`. The pending test must FAIL —
   and if it does not, the test is not proving the card is absent before the
   result arrives, only that it appears after. Fix the test, not the code.
2. Move the `replace(/^@/, "")` to after the `includes("@")` check. The
   handle-with-@ path must break: add a case for `"@ada"` if none fails.
3. Restore and confirm green.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/social/
git commit -m "feat(mobile): add a friend by handle, with a result card before any request (#449)"
```

---

### Task 14: Handle and picture on the profile

**Files:**
- Modify: `apps/mobile/app/profile.tsx`
- Test: `apps/mobile/app/__tests__/profile.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `useMyHandle`, `useSetHandle`, `useClearHandle`, `useUploadAvatar`,
  `useDeleteAvatar` (Task 12); `Avatar` (Task 11); `buildCaptureForm`
  (`apps/mobile/src/api/resolveWire.ts:89`); `expo-image-picker`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the handle when there is one, and an invitation to pick one when there is not", async () => {
  mockMyHandle.mockReturnValue({ data: { handle: "" }, isLoading: false });
  const { getByText } = render(<ProfileScreen />);
  expect(getByText("Pick a handle")).toBeTruthy();
});

it("renders the picture on the profile avatar when the account has one", async () => {
  mockMe.mockReturnValue({ data: { display_name: "Ada L", avatar_url: "https://assets.test/a.jpg" } });
  const { UNSAFE_getAllByType } = render(<ProfileScreen />);
  expect(UNSAFE_getAllByType(Image)[0].props.source).toEqual({ uri: "https://assets.test/a.jpg" });
});

// Removing is immediate and ungated — the same rule the sharing surfaces
// follow: a surface that makes stopping harder than starting works against the
// person it exists for.
it("removes the picture without a confirmation", async () => {
  mockMe.mockReturnValue({ data: { display_name: "Ada L", avatar_url: "https://assets.test/a.jpg" } });
  const { getByText, queryByText } = render(<ProfileScreen />);
  fireEvent.press(getByText("Remove picture"));
  expect(queryByText("Are you sure?")).toBeNull();
  await waitFor(() => expect(mockDeleteAvatar).toHaveBeenCalled());
});

it("surfaces a taken handle as something the user can fix", async () => {
  mockSetHandle.mockRejectedValue(new ApiError(409, "handle_taken", "That handle is taken."));
  const { getByLabelText, getByText } = render(<ProfileScreen />);
  fireEvent.changeText(getByLabelText("Handle"), "ada");
  fireEvent.press(getByText("Save handle"));
  await waitFor(() => expect(getByText("That handle is taken.")).toBeTruthy());
});
```

Read the existing profile screen and mirror however it already mocks `useMe`;
name every mock factory variable with a `mock` prefix.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/mobile && npx jest app/__tests__/profile.test.tsx
```

- [ ] **Step 3: Implement**

In `apps/mobile/app/profile.tsx`:

- Pass `uri={data?.avatar_url}` to the existing `<Avatar ... size={72} />` at
  line 70. This requires `avatar_url` on the `me` response — confirm the API's
  `GET /v1/me` projection carries it; if it does not, add it there in this task,
  as a projected field, **not** by serialising `user.User` (which would leak
  every column the model has, email included).
- Below the avatar, two ghost buttons: "Change picture" and, only when a picture
  exists, "Remove picture".
- A `GroupedSection` for the handle: a `TextInput` labelled `"Handle"`, a "Save
  handle" button, and a "Remove handle" row when one is set.
- Error text under the input, taken straight from the API's message. The four
  write failures already answer differently (Task 5); passing the message
  through is what makes that visible to the person typing.

The picker, reusing the multipart shape that is the only one Expo SDK 57 can
actually send:

```tsx
  const pickPicture = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPictureErr("Kora needs access to your photos to set a picture.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      // The API centre-crops to a square anyway; letting the user choose the
      // crop means the face they meant is the face that is kept.
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (picked.canceled) return;

    const asset = picked.assets[0];
    // buildCaptureForm is the ONE multipart body shape Expo's winter-runtime
    // fetch can send — see the comment on it in src/api/resolveWire.ts. A
    // hand-built { uri, name, type } part throws before any I/O.
    const form = buildCaptureForm({
      uri: asset.uri,
      name: asset.fileName ?? "avatar.jpg",
      type: asset.mimeType ?? "image/jpeg",
    });
    upload.mutate(form, { onError: (e) => setPictureErr(messageOf(e)) });
  };
```

- [ ] **Step 4: Run everything on the client**

```bash
cd apps/mobile && npx jest && npx tsc --noEmit && npx eslint .
```

Do **not** run prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/profile.tsx apps/mobile/app/__tests__/profile.test.tsx
git commit -m "feat(mobile): handle and profile picture on the profile screen (#449)"
```

---

### Task 15: Verify on the device, then open the PR

Tests and the simulator find different defects and neither substitutes for the
other. The last two sessions found, on a device and not in any test: a pending
fetch rendering as a factual claim about someone else's body data, a
200-with-empty reading identically to a 404, a blank display name above a
sentence about that person, and a confirmation panel whose reflow pushed a
destructive button under the user's thumb. Every one of those is a shape this
feature can reproduce.

**Files:** none — this task changes nothing. It produces findings, and each
finding becomes either a fix in an earlier task or a named gap in the PR.

- [ ] **Step 1: Bring the stack up**

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN    # kill THAT pid, not `pkill -f "go run"`
cd api && ASSETS_LOCAL_DIR=/tmp/kora-assets \
  ASSETS_PUBLIC_BASE_URL=http://localhost:8080/assets go run ./cmd/api &
curl -s localhost:8080/ready        # /ready touches the DB; /health does not
cd ../apps/mobile && npx expo start &
```

`ASSETS_LOCAL_DIR` is what makes the upload path real locally without GCS. Serve
it back by adding a static route in `router.go` guarded on
`cfg.AssetsLocalDir != ""` — **development only**, and say so in the comment, or
add it to the local run another way. An avatar that uploads but cannot be
fetched verifies half the path.

**If the dev client launches, bundles, and then silently exits**, that is a
stale `Podfile.lock`, not a JS crash. Metro reports a clean bundle and there is
no crash report; both `simctl launch` and the `expo-development-client` deep
link fail identically, which is the tell.

```bash
cd apps/mobile && rm -rf ios/Pods ios/Podfile.lock && npx pod-install
npx expo run:ios --device "iPhone 17 Pro Max"
```

- [ ] **Step 2: Seed two accounts and walk the whole path**

Reuse the throwaway convention: `tw-*@kora.test`. You need a **second real
Firebase identity** to look yourself up from — a lookup against your own handle
does not exercise the projection that matters.

Walk it end to end, on the device:
1. Profile → pick a handle. Then try to take a handle the other account holds,
   and confirm the message names the reason.
2. Profile → change the handle, then try to reclaim the old one. It must be
   refused as retired, from **both** accounts.
3. Profile → set a picture from the library, with a real photo of a face, not a
   flat test image.
4. From the other account: Add a friend → type the handle → Find. Look at the
   card **while the request is in flight**, not only after.
5. Send the request, accept it, and look at the friend row and the circles
   audit — the picture must be there too, not only on the lookup card.
6. Profile → Remove picture. It must go immediately, with no confirmation.
7. Delete the second account entirely and confirm the object is gone from
   `/tmp/kora-assets`.

- [ ] **Step 3: Look at the four things nobody has looked at**

These are recorded as never verified on any new surface, and this feature adds
five of them:

- **Dark mode.** Every colour here comes from `instrument`, which is the point,
  but a photo behind a hairline border is new.
- **Dynamic Type at accessibility sizes.** The `Avatar` glyph is capped
  (kora#324) but the lookup card's name and handle are not. At AX5, does the
  card still hold a name, a handle and a button?
- **iPhone SE width.** The card is avatar + two lines + button on one row. That
  is the narrowest thing in this feature.
- **VoiceOver focus** when the result card appears. The picture is
  `accessible={false}`; confirm focus lands on the name and that the button's
  label says who it sends to, not just "Send request".
- **A reflow check on the card**, specifically: when the name wraps to two
  lines, does "Send request" move under the thumb resting on the keyboard? That
  is exactly the kora#443 defect, in a new place.

An iOS Alert is invisible to `idb ui describe-all` (separate process) — a blank
accessibility tree on a screen that was working means a modal is up. Screenshot
before concluding anything went stale.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/449-identity-handles-avatars
gh pr create --title "feat(identity): handles and profile pictures (#449)" --body "$(cat <<'BODY'
Closes #449. Implements docs/superpowers/specs/2026-08-25-identity-handle-and-avatar-design.md.

## What changed

- Handles: exact-match lookup only, confusables folded for both uniqueness and
  lookup, retirement permanent. No prefix search, no listing, no directory.
- Profile pictures: uploaded through the API, normalised (pixel cap before
  decode, centre-crop, 512, JPEG re-encode), stored in an object store.
- The API's first rate limiter, on lookup.
- Account deletion removes the object, inside the existing single cascade.

## Deviation from the spec

The spec says `golang.org/x/image/draw` is a genuine new dependency, quoting
`bodyread/downscale.go`. **That file's comment was stale.** kora#365 already
replaced nearest-neighbour with edge-derived box averaging, which IS area
resampling and is the correct filter for a large downscale of a photograph. No
new dependency was added; the primitives moved to `internal/imageproc` and the
stale comment is deleted.

## Not verified

- **Nothing is moderated.** A user-supplied image is shown to anyone holding a
  handle. Defensible at 18 users; not at public launch, which needs a takedown
  path this does not provide.
- **The bucket does not exist.** `kora-prod-assets-in` has never been created —
  see docs/OPEN_QUESTIONS.md. Until it is, `ASSETS_BUCKET` is unset,
  `assets.Noop` is selected, uploads succeed and every avatar URL is empty. That
  is the expected first-deploy state.
- The rate limiter is in-process and exact only while `kora-api` runs one
  replica. Scaled out it becomes limit x replicas — looser, not broken.
- [fill in what step 3 could not check]

## Verified on device

[fill in from step 2 — say what was walked, on how many accounts, and what the
device found that the tests did not]
BODY
)"
```

Read **every CI step**, not the job's colour. `build-image` needs the aggregate
`CI gate`; CI's npm is 10.9.9.

- [ ] **Step 5: Clean up the throwaway state**

The Firebase identities are in `kora-app-e6d38` and must be deleted separately
from the DB rows — deleting the row leaves the identity behind.

```bash
pkill -f "expo start"; lsof -nP -iTCP:8080 -sTCP:LISTEN   # then kill that pid
/opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -U kora -d kora \
  -c "DELETE FROM users WHERE email LIKE 'tw-%@kora.test'"
rm -rf /tmp/kora-assets
```

Then delete each `tw-*@kora.test` identity in the `kora-app-e6d38` Firebase
console. The previous session left `tw-ada@kora.test` behind; check for it too.

---

## Self-review against the spec

Run through this before handing the plan to an executor.

**Spec coverage.** Every section maps to a task:

| Spec section | Task |
|---|---|
| Findability is a deliberate act (exact match) | 3, 5 |
| The handle is the consent boundary (avatar at lookup) | 3, 8, 13 |
| Confusables fold, uniqueness and lookup | 1, 2, 3 |
| Retired handles never return | 2, 3 |
| Both optional, prompted at point of use | 13, 14 |
| Data model | 2 |
| Storage: bucket, path, public-read | 7 |
| Upload path and normalisation order | 6, 8 |
| Deletion removes the object | 9 |
| API surface (5 endpoints) | 5, 8 |
| Lookup 404, never an email | 3, 5 |
| Lookup rate limited | 4, 5 |
| Distinct write errors | 1, 5 |
| Surfaces: profile, AddFriendSheet, result, friends/circles | 10, 13, 14 |
| Testing: pure, DB, image, simulator | 1–9, 15 |

**Two things the spec left implicit, added here:** `FriendView`/`MemberView`
need `avatar_url` or the "existing Avatar gains a real image" line cannot be
true anywhere but lookup (Task 10); and `GET /v1/me` needs `avatar_url` or the
profile cannot render its own picture (Task 14, step 3).

**Out of scope, unchanged:** moderation, universal invite links, phone numbers,
address-book matching, prefix search, directories.

**Execution.** Per the standing preference, this runs
subagent-driven: a fresh subagent per task, with review between tasks. Tasks 1–10
are the API and must land in order; 11–14 are the client and depend on 5, 8 and
10; 15 is last.
