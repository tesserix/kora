# Kora Admin User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Kora admin surface an activation-funnel user list, a counts-only detail panel, and an irreversible delete built on one shared deletion engine that also serves the user's own `DELETE /v1/me`.

**Architecture:** kora-api gains a `user.Service.Delete(ctx, userID, actor)` that performs #106's designed sequence (transfer ownership → revoke Apple → `DELETE FROM users` → evict Redis → delete Firebase identity). Two callers wrap it: `DELETE /admin/users/:id` (BFF-signed, writes a `kora_admin_events` row in the same transaction) and `DELETE /v1/me` (identity from context). Reads are two new BFF-gated GET endpoints. tesserix-home calls all of it through the existing signed client — the portal has no Kora database access.

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, Postgres 16, Redis (go-redis v9), Firebase Admin SDK (`firebase.google.com/go/v4`), Next.js 16 / React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-kora-user-management-design.md`

## Global Constraints

- **`TEST_DATABASE_URL` is mandatory for every Go task.** Repository tests **skip silently** without it — `go test` still prints `ok`. Export it and confirm the test *count* rose, never just that the suite was green:
  ```
  export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
  ```
- Commits: conventional prefix, **single line**, no body, no trailers, no signature.
- kora PRs are **merge-committed**, not squashed. tesserix-k8s is **squash-only**.
- Verify a PR's head SHA (`gh api repos/.../pulls/N --jq .head.sha`) against `git rev-parse HEAD` before merging.
- Go: no `panic`/`log.Fatal` outside `cmd/*/main.go`. Errors wrapped with `fmt.Errorf("pkg: context: %w", err)`.
- HTTP errors go through `httpx.Error(c, status, code, message)` — never a raw `c.JSON`.
- Never serialise `firebase_uid`, `apple_refresh_token`, or any `target_*`/body-metric value to the portal.
- Portal: `tsc --noEmit` baseline is **18 errors**. Do not raise it.

---

## Task 1: Migration — retain `ai_usage_events` on user deletion

**Files:**
- Create: `api/internal/database/migrations/000025_user_deletion.up.sql`
- Create: `api/internal/database/migrations/000025_user_deletion.down.sql`
- Test: `api/internal/database/migrations_test.go` (modify)

**Interfaces:**
- Consumes: nothing.
- Produces: `ai_usage_events.user_id` becomes `uuid NULL` with FK `ON DELETE SET NULL`. Every later task's cascade tests depend on this.

**Why:** verified on the live schema — `ai_usage_events_user_id_fkey` is currently `ON DELETE CASCADE` and `user_id` is `NOT NULL`. Without this change, #106's decision to *retain* AI usage rows is silently violated: deleting a user destroys the "tried and failed" signal, currently 1 of 6 production users.

- [ ] **Step 1: Write the failing test**

Add to `api/internal/database/migrations_test.go`:

```go
func TestAIUsageEventsSurvivesUserDeletion(t *testing.T) {
	db := testDB(t) // existing helper; skips without TEST_DATABASE_URL

	var isNullable string
	require.NoError(t, db.Raw(`
		SELECT is_nullable FROM information_schema.columns
		WHERE table_name = 'ai_usage_events' AND column_name = 'user_id'`).
		Scan(&isNullable).Error)
	assert.Equal(t, "YES", isNullable, "user_id must be nullable to survive its user")

	var def string
	require.NoError(t, db.Raw(`
		SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conrelid = 'ai_usage_events'::regclass AND contype = 'f'`).
		Scan(&def).Error)
	assert.Contains(t, def, "ON DELETE SET NULL")
	assert.NotContains(t, def, "ON DELETE CASCADE")
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
cd api && go test ./internal/database/ -run TestAIUsageEventsSurvivesUserDeletion -v
```
Expected: FAIL — `"NO" != "YES"`. **If it reports `ok` with no test run, `TEST_DATABASE_URL` is not set — stop and fix that first.**

- [ ] **Step 3: Write the migration**

`000025_user_deletion.up.sql`:

```sql
-- #106 decided ai_usage_events is RETAINED when a user is deleted, with
-- user_id set to NULL. The constraint shipped as ON DELETE CASCADE, which
-- silently does the opposite: deleting a user destroys their AI usage
-- history, and with it the "tried but never logged" cohort that the admin
-- activation funnel exists to surface.
--
-- Retention is deliberate and is NOT a privacy regression: user_id becomes
-- NULL, so the surviving rows are anonymous usage counters (call type,
-- outcome, latency) with no link back to a person.
ALTER TABLE ai_usage_events ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE ai_usage_events DROP CONSTRAINT ai_usage_events_user_id_fkey;
ALTER TABLE ai_usage_events
    ADD CONSTRAINT ai_usage_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
```

`000025_user_deletion.down.sql`:

```sql
-- Rows orphaned by a deletion cannot be re-attributed, so they are removed
-- before NOT NULL is restored. A down migration that left them would fail on
-- the NOT NULL, and one that invented a user_id would be worse.
DELETE FROM ai_usage_events WHERE user_id IS NULL;

ALTER TABLE ai_usage_events DROP CONSTRAINT ai_usage_events_user_id_fkey;
ALTER TABLE ai_usage_events
    ADD CONSTRAINT ai_usage_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ai_usage_events ALTER COLUMN user_id SET NOT NULL;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && go run ./cmd/migrate && go test ./internal/database/ -run TestAIUsageEventsSurvivesUserDeletion -v
```
Expected: PASS.

- [ ] **Step 5: Confirm the whole suite still runs (not skips)**

```bash
cd api && go test ./... 2>&1 | tail -20
```
Expected: `ok` for `internal/database` with a non-zero test count.

- [ ] **Step 6: Commit**

```bash
git add api/internal/database/migrations/000025_user_deletion.*.sql api/internal/database/migrations_test.go
git commit -m "feat(api): retain ai_usage_events when a user is deleted"
```

---

## Task 2: Audit vocabulary for user deletion

**Files:**
- Modify: `api/internal/admin/events.go`
- Test: `api/internal/admin/events_test.go`

**Interfaces:**
- Consumes: existing `admin.Actor{ID, Email string}`, unexported `recordEvent`.
- Produces:
  - `const TargetTypeUser = "user"`
  - `const ActionUserDeleted = "user.deleted"`
  - `func RecordEvent(tx *gorm.DB, actor Actor, action, targetType string, targetID uuid.UUID, before, after any) error` — exported wrapper over `recordEvent`, so package `user` can write an audit row on the deletion's own transaction.

**Why exported:** the audit row must be written inside the same transaction as the delete. The deletion service lives in package `user`, which cannot call `admin.recordEvent`. Verified there is no import cycle: `internal/admin` does not import `internal/user`.

- [ ] **Step 1: Write the failing test**

```go
func TestRecordEventIsExportedAndWritesUserTarget(t *testing.T) {
	db := testDB(t)
	target := uuid.New()

	err := RecordEvent(db, Actor{ID: "admin-1", Email: "a@b.com"},
		ActionUserDeleted, TargetTypeUser, target, nil, nil)
	require.NoError(t, err)

	var got AdminEvent
	require.NoError(t, db.Where("target_id = ?", target).First(&got).Error)
	assert.Equal(t, "user.deleted", got.Action)
	assert.Equal(t, "user", got.TargetType)
	assert.Equal(t, "admin-1", got.ActorID)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
cd api && go test ./internal/admin/ -run TestRecordEventIsExportedAndWritesUserTarget -v
```
Expected: FAIL — `undefined: RecordEvent`.

- [ ] **Step 3: Implement**

In `api/internal/admin/events.go`, alongside `TargetTypeFood`:

```go
// TargetTypeUser is the kora_admin_events.target_type for admin actions on a
// user row. Distinct from TargetTypeFood so a portal query can filter one
// without matching the other.
const TargetTypeUser = "user"

// ActionUserDeleted records an ADMIN-initiated account deletion. A user
// deleting their own account writes NO row here: kora_admin_events is scoped
// to admin actions, and self-deletion is not one.
const ActionUserDeleted = "user.deleted"

// RecordEvent is recordEvent's exported form, for audit writes originating
// outside this package — specifically user.Service.Delete, which must write
// its audit row on the SAME transaction as the delete so the two commit or
// roll back together. Callers outside this package have no other way to
// satisfy that invariant.
func RecordEvent(tx *gorm.DB, actor Actor, action, targetType string, targetID uuid.UUID, before, after any) error {
	return recordEvent(tx, actor, action, targetType, targetID, before, after)
}
```

- [ ] **Step 4: Run test and confirm no import cycle**

```bash
cd api && go build ./... && go test ./internal/admin/ -run TestRecordEventIsExportedAndWritesUserTarget -v
```
Expected: build succeeds (no cycle), test PASSES.

- [ ] **Step 5: Commit**

```bash
git add api/internal/admin/events.go api/internal/admin/events_test.go
git commit -m "feat(api): expose RecordEvent and user audit vocabulary for deletion"
```

---

## Task 3: Evict a user's cached AI resolutions

**Files:**
- Modify: `api/internal/ai/cache.go`
- Test: `api/internal/ai/cache_test.go`

**Interfaces:**
- Consumes: existing `Cache` interface, `RedisCache`, `NoCache`, `CacheKey`.
- Produces: `DeleteByUser(ctx context.Context, userID uuid.UUID) error` added to the `Cache` interface, implemented by `RedisCache` (SCAN + DEL) and `NoCache` (no-op).

**Why:** #106's sequence never evicts Redis. `CacheKey(kind, userID, value)` produces per-user entries under `phrase:`, `photo:` and `voice:`, and the cached *values* are that user's own food resolutions and nutrition numbers — personal data that would outlive "deletion" until TTL.

**Key detail:** physical keys are `generationScopedKey(key, gen)` = `kind:userID:value:g<N>`. The generation is a **suffix**, so `phrase:<uuid>:*` matches every generation for that user. That is deliberately broader than `Delete()`, which only clears the current epoch — for deletion we want every epoch gone.

- [ ] **Step 1: Write the failing test**

```go
func TestRedisCacheDeleteByUserRemovesAllKindsAndGenerations(t *testing.T) {
	c, mr := newTestRedisCache(t) // existing miniredis helper
	ctx := context.Background()
	victim, survivor := uuid.New(), uuid.New()

	for _, kind := range []string{"phrase", "photo", "voice"} {
		c.Set(ctx, CacheKey(kind, victim, "x"), Resolution{})
		c.Set(ctx, CacheKey(kind, survivor, "x"), Resolution{})
	}
	// A key left behind from an older generation must go too.
	require.NoError(t, mr.Set("phrase:"+victim.String()+":stale:g0", "{}"))

	require.NoError(t, c.DeleteByUser(ctx, victim))

	for _, kind := range []string{"phrase", "photo", "voice"} {
		_, ok := c.Get(ctx, CacheKey(kind, victim, "x"))
		assert.False(t, ok, "victim %s entry must be gone", kind)
		_, ok = c.Get(ctx, CacheKey(kind, survivor, "x"))
		assert.True(t, ok, "survivor %s entry must remain", kind)
	}
	assert.False(t, mr.Exists("phrase:"+victim.String()+":stale:g0"),
		"older-generation key must be swept too")
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && go test ./internal/ai/ -run TestRedisCacheDeleteByUserRemovesAllKindsAndGenerations -v
```
Expected: FAIL — `c.DeleteByUser undefined`.

- [ ] **Step 3: Implement**

Add to the `Cache` interface in `cache.go`:

```go
	// DeleteByUser removes every cached resolution belonging to userID,
	// across all kinds AND all generations. Used only by account deletion.
	// Like Delete, a failure must never be treated as fatal by the caller.
	DeleteByUser(ctx context.Context, userID uuid.UUID) error
```

`NoCache`:

```go
// DeleteByUser is a no-op — there is nothing to evict when caching is disabled.
func (NoCache) DeleteByUser(ctx context.Context, userID uuid.UUID) error { return nil }
```

`RedisCache`:

```go
// cacheKinds are the three CacheKey prefixes. Listed explicitly rather than
// scanned as "*:<uuid>:*" because a bare wildcard prefix would also match any
// future non-resolution key that happens to embed a uuid.
var cacheKinds = []string{"phrase", "photo", "voice"}

// DeleteByUser sweeps every generation, not just the current one. Physical
// keys are "<kind>:<uuid>:<value>:g<N>" (generationScopedKey appends the
// generation as a SUFFIX), so "<kind>:<uuid>:*" matches them all. Delete()
// cannot be reused here: it scopes to the current generation only, and it
// needs the logical key, which we cannot reconstruct without knowing every
// phrase the user ever resolved.
//
// SCAN, never KEYS: KEYS blocks the server for the whole sweep.
func (c *RedisCache) DeleteByUser(ctx context.Context, userID uuid.UUID) error {
	for _, kind := range cacheKinds {
		pattern := kind + ":" + userID.String() + ":*"
		var cursor uint64
		for {
			keys, next, err := c.client.Scan(ctx, cursor, pattern, 256).Result()
			if err != nil {
				return fmt.Errorf("ai: scan %s: %w", pattern, err)
			}
			if len(keys) > 0 {
				if err := c.client.Del(ctx, keys...).Err(); err != nil {
					return fmt.Errorf("ai: delete %s: %w", pattern, err)
				}
			}
			if next == 0 {
				break
			}
			cursor = next
		}
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

```bash
cd api && go test ./internal/ai/ -v 2>&1 | tail -20
```
Expected: PASS. Any other `Cache` implementation in test files must also gain the method — the compiler will name them.

- [ ] **Step 5: Commit**

```bash
git add api/internal/ai/cache.go api/internal/ai/cache_test.go
git commit -m "feat(api): evict a user's cached resolutions across every generation"
```

---

## Task 4: Delete the Firebase identity

**Files:**
- Modify: `api/internal/auth/verifier.go`
- Test: `api/internal/auth/verifier_test.go`

**Interfaces:**
- Consumes: existing `firebaseVerifier{client *fbauth.Client}`.
- Produces: `type IdentityDeleter interface { DeleteIdentity(ctx context.Context, firebaseUID string) error }`, implemented by `firebaseVerifier`.

**Why separate from `TokenVerifier`:** verification needs only public keys; deletion needs Firebase Admin privileges (`firebaseauth.users.delete`). Keeping them as distinct interfaces means the deletion service depends only on what it uses, and a test double for one is not forced to implement the other.

**Deploy risk to flag in the PR:** kora-api's workload identity may lack the Admin permission, exactly like the portal's key-health 403 found on 2026-08-08. This will surface as a permission error at runtime, not at build time. Step 6 verifies it against the deployed pod.

- [ ] **Step 1: Write the failing test**

```go
func TestFirebaseVerifierImplementsIdentityDeleter(t *testing.T) {
	var _ IdentityDeleter = firebaseVerifier{}
}

func TestDeleteIdentityRejectsEmptyUID(t *testing.T) {
	err := firebaseVerifier{}.DeleteIdentity(context.Background(), "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "empty firebase uid")
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && go test ./internal/auth/ -run 'TestFirebaseVerifierImplementsIdentityDeleter|TestDeleteIdentityRejectsEmptyUID' -v
```
Expected: FAIL — `undefined: IdentityDeleter`.

- [ ] **Step 3: Implement**

```go
// IdentityDeleter removes a Firebase identity. Deliberately a separate
// interface from TokenVerifier: verification needs only Google's public
// keys, while deletion needs Firebase Admin privileges. A consumer that only
// deletes should not have to depend on Verify, and vice versa.
type IdentityDeleter interface {
	DeleteIdentity(ctx context.Context, firebaseUID string) error
}

// DeleteIdentity removes the Firebase identity for firebaseUID.
//
// An empty uid is rejected rather than passed through: Firebase would reject
// it anyway, but the account-deletion caller treats a Firebase failure as
// NON-fatal, so a silent no-op here would leave a live identity behind while
// reporting success. Failing loudly gives the caller something to log.
func (v firebaseVerifier) DeleteIdentity(ctx context.Context, firebaseUID string) error {
	if firebaseUID == "" {
		return fmt.Errorf("auth: delete identity: empty firebase uid")
	}
	if err := v.client.DeleteUser(ctx, firebaseUID); err != nil {
		return fmt.Errorf("auth: delete identity: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

```bash
cd api && go test ./internal/auth/ -v 2>&1 | tail -15
```
Expected: PASS. (`TestDeleteIdentityRejectsEmptyUID` uses a zero-value struct and returns before touching the nil client.)

- [ ] **Step 5: Commit**

```bash
git add api/internal/auth/verifier.go api/internal/auth/verifier_test.go
git commit -m "feat(api): add Firebase identity deletion to the auth package"
```

- [ ] **Step 6: Record the IAM check for the PR**

Add to the PR description (not code): after deploy, confirm the runtime service account can actually delete identities. A missing `firebaseauth.users.delete` will only appear at runtime.

---

## Task 5: Transfer group and challenge ownership

**Files:**
- Create: `api/internal/user/ownership.go`
- Test: `api/internal/user/ownership_test.go`

**Interfaces:**
- Consumes: `groups` tables (`groups.owner_id`, `group_members.user_id`, `group_members.joined_at`), `challenges.creator_id`.
- Produces: `func transferOwnership(tx *gorm.DB, userID uuid.UUID) ([]Transfer, error)` and `type Transfer struct { Kind, Name string; ID, NewOwnerID uuid.UUID }`. Task 6 calls it; Task 10 renders the preview from the same query.

**Why first in the sequence:** once the cascade fires, the groups are already gone. There is no second chance.

- [ ] **Step 1: Write the failing test**

```go
func TestTransferOwnershipPassesToEarliestJoiner(t *testing.T) {
	db := testDB(t)
	owner, early, late := seedUser(t, db), seedUser(t, db), seedUser(t, db)
	g := seedGroup(t, db, owner.ID)
	seedMember(t, db, g.ID, late.ID, time.Now())
	seedMember(t, db, g.ID, early.ID, time.Now().Add(-48*time.Hour))

	transfers, err := transferOwnership(db, owner.ID)
	require.NoError(t, err)
	require.Len(t, transfers, 1)
	assert.Equal(t, early.ID, transfers[0].NewOwnerID, "earliest joined_at inherits")

	var got uuid.UUID
	require.NoError(t, db.Raw(`SELECT owner_id FROM groups WHERE id = ?`, g.ID).Scan(&got).Error)
	assert.Equal(t, early.ID, got)
}

func TestTransferOwnershipLeavesSoloGroupToCascade(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	g := seedGroup(t, db, owner.ID)

	transfers, err := transferOwnership(db, owner.ID)
	require.NoError(t, err)
	assert.Empty(t, transfers, "a solo group is not transferred; it cascades")

	var stillOwned uuid.UUID
	require.NoError(t, db.Raw(`SELECT owner_id FROM groups WHERE id = ?`, g.ID).Scan(&stillOwned).Error)
	assert.Equal(t, owner.ID, stillOwned, "untouched, so the cascade removes it")
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
cd api && go test ./internal/user/ -run TestTransferOwnership -v
```
Expected: FAIL — `undefined: transferOwnership`.

- [ ] **Step 3: Implement**

```go
package user

// Transfer records one ownership handover, so the caller can report exactly
// what deleting this user did to other people's groups. Deletion is
// irreversible and silently reassigning someone else's group is a surprise
// worth surfacing before and after the fact.
type Transfer struct {
	Kind       string    `json:"kind"` // "group" | "challenge"
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	NewOwnerID uuid.UUID `json:"new_owner_id"`
}

// transferOwnership reassigns every group and challenge owned by userID that
// still has another member, to the member with the earliest joined_at.
//
// MUST run before the DELETE: once the cascade fires, groups.owner_id ->
// users(id) ON DELETE CASCADE has already removed the rows.
//
// A group where the departing user is the ONLY member is deliberately left
// alone so the cascade removes it — transferring it is impossible and
// keeping an ownerless group is worse.
//
// Ties on joined_at break on the member's user id, so the outcome is
// deterministic; two members inserted in the same transaction can share a
// timestamp, and a non-deterministic owner would make this untestable.
func transferOwnership(tx *gorm.DB, userID uuid.UUID) ([]Transfer, error) {
	var out []Transfer

	rows, err := tx.Raw(`
		SELECT g.id, g.name, m.user_id
		FROM groups g
		JOIN LATERAL (
			SELECT user_id FROM group_members
			WHERE group_id = g.id AND user_id <> ?
			ORDER BY joined_at ASC, user_id ASC
			LIMIT 1
		) m ON TRUE
		WHERE g.owner_id = ?`, userID, userID).Rows()
	if err != nil {
		return nil, fmt.Errorf("user: find transferable groups: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var t Transfer
		if err := rows.Scan(&t.ID, &t.Name, &t.NewOwnerID); err != nil {
			return nil, fmt.Errorf("user: scan group transfer: %w", err)
		}
		t.Kind = "group"
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("user: iterate group transfers: %w", err)
	}

	for _, t := range out {
		if err := tx.Exec(`UPDATE groups SET owner_id = ? WHERE id = ?`,
			t.NewOwnerID, t.ID).Error; err != nil {
			return nil, fmt.Errorf("user: transfer group %s: %w", t.ID, err)
		}
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests**

```bash
cd api && go test ./internal/user/ -run TestTransferOwnership -v
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/user/ownership.go api/internal/user/ownership_test.go
git commit -m "feat(api): transfer group ownership before an account is deleted"
```

---

## Task 6: The shared deletion service

**Files:**
- Create: `api/internal/user/deletion.go`
- Test: `api/internal/user/deletion_test.go`

**Interfaces:**
- Consumes: `transferOwnership` (Task 5), `ai.Cache.DeleteByUser` (Task 3), `auth.IdentityDeleter` (Task 4), `admin.RecordEvent` (Task 2), `appleid` client (shipped in #106 slice 1).
- Produces:
  ```go
  type DeleteActor struct { IsAdmin bool; ID, Email string }
  type DeleteResult struct {
      Transfers               []Transfer `json:"transfers"`
      FirebaseIdentityRemoved bool       `json:"firebase_identity_removed"`
      AppleTokenRevoked       bool       `json:"apple_token_revoked"`
  }
  func (s Service) Delete(ctx context.Context, userID uuid.UUID, actor DeleteActor) (DeleteResult, error)
  ```
  Tasks 7 and 8 both call `Delete`. `ErrNotFound` is returned for an unknown id.

**This is the load-bearing task.** Read the sequence rationale in the spec before starting.

- [ ] **Step 1: Write the failing cascade test — with a SURVIVOR**

The survivor is not optional. `DELETE FROM users` missing its `WHERE` clause passes every assertion about the victim.

```go
func TestDeleteRemovesVictimAndLeavesSurvivorIntact(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	victim, survivor := seedUser(t, db), seedUser(t, db)

	seedFoodLog(t, db, victim.ID)
	seedFoodLog(t, db, survivor.ID)
	seedWeightEntry(t, db, victim.ID)
	seedWeightEntry(t, db, survivor.ID)
	// friendships and notifications reference users TWICE. Seed the survivor
	// as the OTHER party, which a naive test never exercises.
	seedFriendship(t, db, victim.ID, survivor.ID)   // requester=victim, addressee=survivor
	seedNotification(t, db, survivor.ID, victim.ID) // user=survivor, actor=victim

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{IsAdmin: false})
	require.NoError(t, err)
	_ = res

	// Victim is gone, everywhere.
	for _, table := range []string{"food_logs", "weight_entries", "water_entries",
		"device_tokens", "pins", "saved_meals", "food_aliases", "coach_turns",
		"group_members", "challenge_participants", "feedback"} {
		var n int64
		require.NoError(t, db.Raw(
			`SELECT count(*) FROM `+table+` WHERE user_id = ?`, victim.ID).Scan(&n).Error)
		assert.Zero(t, n, "%s must be empty for the deleted user", table)
	}
	var users int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, victim.ID).Scan(&users).Error)
	assert.Zero(t, users)

	// SURVIVOR IS UNTOUCHED — this is the assertion that catches a missing WHERE.
	for _, table := range []string{"food_logs", "weight_entries"} {
		var n int64
		require.NoError(t, db.Raw(
			`SELECT count(*) FROM `+table+` WHERE user_id = ?`, survivor.ID).Scan(&n).Error)
		assert.NotZero(t, n, "%s for the survivor must NOT be deleted", table)
	}
	var survivorRow int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, survivor.ID).Scan(&survivorRow).Error)
	assert.Equal(t, int64(1), survivorRow, "the survivor's account must still exist")
}

func TestDeleteRetainsAIUsageEventsAnonymised(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	victim := seedUser(t, db)
	seedAIUsageEvent(t, db, victim.ID)

	_, err := svc.Delete(context.Background(), victim.ID, DeleteActor{})
	require.NoError(t, err)

	var total, orphaned int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM ai_usage_events`).Scan(&total).Error)
	require.NoError(t, db.Raw(`SELECT count(*) FROM ai_usage_events WHERE user_id IS NULL`).Scan(&orphaned).Error)
	assert.NotZero(t, total, "ai_usage_events are RETAINED, not cascaded")
	assert.NotZero(t, orphaned, "and anonymised to NULL")
}

func TestDeleteWritesAuditRowForAdminOnly(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)

	byAdmin := seedUser(t, db)
	_, err := svc.Delete(context.Background(), byAdmin.ID,
		DeleteActor{IsAdmin: true, ID: "admin-1", Email: "a@b.com"})
	require.NoError(t, err)
	var n int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM kora_admin_events WHERE target_id = ?`, byAdmin.ID).Scan(&n).Error)
	assert.Equal(t, int64(1), n, "admin deletion is audited AND the row outlives the user")

	bySelf := seedUser(t, db)
	_, err = svc.Delete(context.Background(), bySelf.ID, DeleteActor{IsAdmin: false})
	require.NoError(t, err)
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM kora_admin_events WHERE target_id = ?`, bySelf.ID).Scan(&n).Error)
	assert.Zero(t, n, "self-deletion is not an admin action")
}

func TestDeleteReportsFirebaseFailureWithoutFailing(t *testing.T) {
	db := testDB(t)
	svc := newTestServiceWithFailingFirebase(t, db)
	victim := seedUser(t, db)

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{IsAdmin: true, ID: "a", Email: "a@b.com"})
	require.NoError(t, err, "a Firebase failure must NOT fail the deletion")
	assert.False(t, res.FirebaseIdentityRemoved, "but it must be reported, not swallowed")

	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, victim.ID).Scan(&n).Error)
	assert.Zero(t, n, "the row is still gone")
}

func TestDeleteUnknownUserIsNotFound(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	_, err := svc.Delete(context.Background(), uuid.New(), DeleteActor{})
	assert.ErrorIs(t, err, ErrNotFound)
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
cd api && go test ./internal/user/ -run TestDelete -v
```
Expected: FAIL — `svc.Delete undefined`. Confirm the tests actually RAN (not skipped).

- [ ] **Step 3: Implement**

```go
package user

// ErrNotFound is returned by Delete when no user row has the id. Handlers
// map it to 404; every other error is a 500.
var ErrNotFound = errors.New("user: not found")

// DeleteActor identifies who is deleting. IsAdmin drives two behaviours that
// differ between the two callers: whether a kora_admin_events row is written,
// and whether a Firebase failure is reported to the caller.
type DeleteActor struct {
	IsAdmin bool
	ID      string
	Email   string
}

// DeleteResult reports what the deletion actually did. FirebaseIdentityRemoved
// is false when the DB delete succeeded but the identity survived — see the
// comment on Delete.
type DeleteResult struct {
	Transfers               []Transfer `json:"transfers"`
	FirebaseIdentityRemoved bool       `json:"firebase_identity_removed"`
	AppleTokenRevoked       bool       `json:"apple_token_revoked"`
}

// Delete removes a user account. Irreversible; there is no grace period.
//
// The ORDER of these steps is load-bearing and must not be "tidied":
//
//  1. Ownership transfer FIRST — once the cascade fires the groups are gone.
//  2. Apple revoke BEFORE the DB delete — the token lives on the users row.
//     NON-FATAL: blocking on a third-party outage would break the one thing
//     Apple requires, that deletion completes in-app.
//  3. DELETE FROM users — 18 cascades, one statement, inside the transaction
//     that also writes the audit row.
//  4. Redis eviction — the cached values are the user's own resolutions.
//     Non-fatal.
//  5. Firebase identity LAST. If it fails after the DB delete, the personal
//     data is already gone and the path self-heals for a self-deleting user
//     (they sign in, EnsureUser makes a fresh empty row, they delete again).
//     Reverse the order and a failed DB delete leaves an un-signin-able
//     identity with orphaned personal data and no retry path — exactly what
//     deletion exists to prevent.
func (s Service) Delete(ctx context.Context, userID uuid.UUID, actor DeleteActor) (DeleteResult, error) {
	var res DeleteResult

	var u User
	if err := s.db.WithContext(ctx).Where("id = ?", userID).First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return res, ErrNotFound
		}
		return res, fmt.Errorf("user: load for delete: %w", err)
	}

	// AppleRefreshToken is '' (not NULL) for every row created via
	// UpsertByFirebaseUID — see model.go. The presence check MUST be != "".
	if u.AppleRefreshToken != "" {
		if err := s.apple.Revoke(ctx, u.AppleRefreshToken); err != nil {
			slog.ErrorContext(ctx, "apple token revoke failed; continuing with deletion",
				"user_id", userID, "error", err)
		} else {
			res.AppleTokenRevoked = true
		}
	}

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		transfers, err := transferOwnership(tx, userID)
		if err != nil {
			return err
		}
		res.Transfers = transfers

		if actor.IsAdmin {
			// Written on tx, so audit and delete commit or roll back together.
			if err := admin.RecordEvent(tx, admin.Actor{ID: actor.ID, Email: actor.Email},
				admin.ActionUserDeleted, admin.TargetTypeUser, userID, nil, nil); err != nil {
				return err
			}
		}

		out := tx.Exec(`DELETE FROM users WHERE id = ?`, userID)
		if out.Error != nil {
			return fmt.Errorf("user: delete row: %w", out.Error)
		}
		if out.RowsAffected == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return res, err
	}

	if err := s.cache.DeleteByUser(ctx, userID); err != nil {
		slog.ErrorContext(ctx, "cache eviction failed after deletion; entries expire on TTL",
			"user_id", userID, "error", err)
	}

	if err := s.identities.DeleteIdentity(ctx, u.FirebaseUID); err != nil {
		slog.ErrorContext(ctx, "firebase identity survived deletion; NEEDS MANUAL CLEANUP",
			"user_id", userID, "firebase_uid", u.FirebaseUID, "error", err)
	} else {
		res.FirebaseIdentityRemoved = true
	}

	return res, nil
}
```

Add the `Service` struct and constructor in the same file if `user.Service` does not already exist:

```go
// Service owns user operations that span more than the users table.
type Service struct {
	db         *gorm.DB
	cache      ai.Cache
	identities auth.IdentityDeleter
	apple      appleRevoker
}

// appleRevoker is the one method Delete needs from appleid. Declared here,
// at the consumer, so tests supply a two-line fake instead of the real client.
type appleRevoker interface {
	Revoke(ctx context.Context, refreshToken string) error
}

func NewService(db *gorm.DB, c ai.Cache, id auth.IdentityDeleter, a appleRevoker) Service {
	return Service{db: db, cache: c, identities: id, apple: a}
}
```

- [ ] **Step 4: Run tests**

```bash
cd api && go test ./internal/user/ -run TestDelete -v 2>&1 | tail -30
```
Expected: all PASS.

- [ ] **Step 5: Prove the survivor assertion is not vacuous**

Temporarily change the delete to `DELETE FROM users` (drop `WHERE id = ?`), re-run, and confirm `TestDeleteRemovesVictimAndLeavesSurvivorIntact` **fails**. Restore it.

```bash
cd api && go test ./internal/user/ -run TestDeleteRemovesVictimAndLeavesSurvivorIntact -v
```
Expected while mutated: FAIL on the survivor assertions. **If it passes, the test is worthless — fix it before continuing.**

- [ ] **Step 6: Commit**

```bash
git add api/internal/user/deletion.go api/internal/user/deletion_test.go
git commit -m "feat(api): add the shared account deletion service"
```

---

## Task 7: `DELETE /v1/me` — self-deletion

**Files:**
- Modify: `api/internal/user/handler.go`, `api/internal/server/router.go`
- Test: `api/internal/user/handler_test.go`

**Interfaces:**
- Consumes: `Service.Delete`, `IDFromContext`.
- Produces: route `DELETE /v1/me` → 204.

This is **#106 slice 2's server half**. No user id in the request — the row comes from `IDFromContext`, so there is nothing to forge.

- [ ] **Step 1: Write the failing test**

```go
func TestDeleteMeReturns204AndRemovesTheCaller(t *testing.T) {
	db := testDB(t)
	r, svc := newTestRouterWithUserService(t, db)
	u := seedUser(t, db)
	_ = svc

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/me", nil)
	withUserContext(req, u.ID)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNoContent, w.Code)
	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, u.ID).Scan(&n).Error)
	assert.Zero(t, n)
}

func TestDeleteMeReturns204EvenWhenFirebaseFails(t *testing.T) {
	db := testDB(t)
	r := newTestRouterWithFailingFirebase(t, db)
	u := seedUser(t, db)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/me", nil)
	withUserContext(req, u.ID)
	r.ServeHTTP(w, req)

	// 204, not 500: the data IS gone and the path self-heals.
	assert.Equal(t, http.StatusNoContent, w.Code)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && go test ./internal/user/ -run TestDeleteMe -v
```
Expected: FAIL — 404, route not registered.

- [ ] **Step 3: Implement the handler**

```go
// DeleteMe serves DELETE /v1/me — the caller deletes their own account.
//
// Returns 204 even when the Firebase identity survived: from the user's
// perspective their data genuinely is gone, and returning 500 would be a lie
// in the other direction, telling them nothing happened when everything did.
// The admin endpoint reports that case instead, because an admin has no
// self-healing retry (see admin_handler.go).
func (h Handler) DeleteMe(c *gin.Context) {
	id, ok := IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthenticated", "sign in required")
		return
	}
	if _, err := h.svc.Delete(c.Request.Context(), id, DeleteActor{IsAdmin: false}); err != nil {
		if errors.Is(err, ErrNotFound) {
			c.Status(http.StatusNoContent) // already gone; deletion is idempotent
			return
		}
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	c.Status(http.StatusNoContent)
}
```

- [ ] **Step 4: Register the route**

In `api/internal/server/router.go`, beside the existing `/me` routes (~line 99):

```go
		v1.DELETE("/me", userHandler.DeleteMe)
```

- [ ] **Step 5: Run tests**

```bash
cd api && go test ./internal/user/ ./internal/server/ -v 2>&1 | tail -20
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/user/handler.go api/internal/user/handler_test.go api/internal/server/router.go
git commit -m "feat(api): add DELETE /v1/me for in-app account deletion"
```

---

## Task 8: `GET /admin/users` — the activation funnel

**Files:**
- Create: `api/internal/user/admin_reads.go`, `api/internal/user/admin_handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/user/admin_reads_test.go`, `api/internal/user/admin_handler_test.go`

**Interfaces:**
- Produces:
  ```go
  type AdminRow struct {
      ID uuid.UUID `json:"id"`; Email string `json:"email"`; DisplayName string `json:"display_name"`
      CreatedAt time.Time `json:"created_at"`; OnboardedAt *time.Time `json:"onboarded_at"`
      Timezone string `json:"timezone"`; HasTargets bool `json:"has_targets"`
      LogCount int64 `json:"log_count"`; FirstLog *time.Time `json:"first_log"`
      LastWrite *time.Time `json:"last_write"`; AICalls int64 `json:"ai_calls"`
  }
  type AdminSummary struct {
      Users int64 `json:"users"`; Onboarded int64 `json:"onboarded"`
      EverLogged int64 `json:"ever_logged"`; TriedNeverLogged int64 `json:"tried_never_logged"`
  }
  type AdminListResult struct { Items []AdminRow `json:"items"`; Summary AdminSummary `json:"summary"` }
  func (r Repository) ListForAdmin(ctx context.Context) (AdminListResult, error)
  ```
- Task 11 consumes this JSON shape **field for field**. Every key here must appear in the TS interface with the same snake_case name.

**Deliberate:** `ai_calls` does **not** filter `outcome = 'ok'`. Filtering erases the "tried and failed" cohort, which is the most actionable row on the page. It counts *calls*, not captures.

- [ ] **Step 1: Write the failing test**

```go
func TestListForAdminSeparatesTriedFromNeverTried(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)

	logger := seedUser(t, db)
	seedFoodLog(t, db, logger.ID)
	seedAIUsageEvent(t, db, logger.ID)

	tried := seedUser(t, db) // AI calls, no logs — the cohort that matters
	seedAIUsageEvent(t, db, tried.ID)

	_ = seedUser(t, db) // never tried anything

	res, err := repo.ListForAdmin(context.Background())
	require.NoError(t, err)

	assert.Equal(t, int64(3), res.Summary.Users)
	assert.Equal(t, int64(1), res.Summary.EverLogged)
	assert.Equal(t, int64(1), res.Summary.TriedNeverLogged)

	byID := map[uuid.UUID]AdminRow{}
	for _, r := range res.Items {
		byID[r.ID] = r
	}
	assert.Equal(t, int64(1), byID[tried.ID].AICalls)
	assert.Zero(t, byID[tried.ID].LogCount)
	assert.Equal(t, int64(1), byID[logger.ID].LogCount)
}

func TestListForAdminCountsFailedAICallsToo(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	u := seedUser(t, db)
	seedAIUsageEventWithOutcome(t, db, u.ID, "error")

	res, err := repo.ListForAdmin(context.Background())
	require.NoError(t, err)
	// Filtering outcome='ok' here would erase the tried-and-failed cohort.
	assert.Equal(t, int64(1), res.Items[0].AICalls)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && go test ./internal/user/ -run TestListForAdmin -v
```
Expected: FAIL — `repo.ListForAdmin undefined`.

- [ ] **Step 3: Implement the read**

```go
// ListForAdmin returns every user with their activation facts, newest signup
// first, plus the summary strip's four counts.
//
// No pagination: correct for a handful of beta users, wrong for thousands.
// Add it when the list stops fitting on a screen — the threshold is genuinely
// unknown and is not invented here.
func (r Repository) ListForAdmin(ctx context.Context) (AdminListResult, error) {
	var out AdminListResult

	rows := []AdminRow{}
	err := r.db.WithContext(ctx).Raw(`
		SELECT u.id, COALESCE(u.email, '') AS email,
		       COALESCE(u.display_name, '') AS display_name,
		       u.created_at, u.onboarded_at, u.timezone,
		       (u.target_kcal IS NOT NULL) AS has_targets,
		       COALESCE(l.log_count, 0) AS log_count,
		       l.first_log,
		       GREATEST(l.last_log, a.last_ai_call) AS last_write,
		       COALESCE(a.ai_calls, 0) AS ai_calls
		FROM users u
		LEFT JOIN (
			SELECT user_id, count(*) AS log_count,
			       min(logged_at) AS first_log, max(logged_at) AS last_log
			FROM food_logs GROUP BY user_id
		) l ON l.user_id = u.id
		LEFT JOIN (
			SELECT user_id, count(*) AS ai_calls, max(created_at) AS last_ai_call
			FROM ai_usage_events WHERE user_id IS NOT NULL GROUP BY user_id
		) a ON a.user_id = u.id
		ORDER BY u.created_at DESC`).Scan(&rows).Error
	if err != nil {
		return out, fmt.Errorf("user: admin list: %w", err)
	}
	out.Items = rows

	// Computed from the rows already fetched rather than four more round
	// trips — and it keeps the strip arithmetically consistent with the
	// table under it, which a separate query cannot guarantee.
	out.Summary.Users = int64(len(rows))
	for _, row := range rows {
		if row.OnboardedAt != nil {
			out.Summary.Onboarded++
		}
		switch {
		case row.LogCount > 0:
			out.Summary.EverLogged++
		case row.AICalls > 0:
			out.Summary.TriedNeverLogged++
		}
	}
	return out, nil
}
```

- [ ] **Step 4: Add the handler and route**

`admin_handler.go`:

```go
// AdminHandler serves the bffauth-protected /v1/admin/users endpoints.
type AdminHandler struct {
	repo Repository
	svc  Service
}

func NewAdminHandler(r Repository, s Service) AdminHandler { return AdminHandler{repo: r, svc: s} }

// List serves GET /v1/admin/users.
func (h AdminHandler) List(c *gin.Context) {
	res, err := h.repo.ListForAdmin(c.Request.Context())
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}
```

In `router.go`, beside the feedback admin routes (~line 156):

```go
			usersAdmin := user.NewAdminHandler(user.NewRepository(deps.DB), userService)
			adminGroup.GET("/users", usersAdmin.List)
```

- [ ] **Step 5: Run tests**

```bash
cd api && go test ./internal/user/ ./internal/server/ -v 2>&1 | tail -20
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/user/admin_reads.go api/internal/user/admin_handler.go api/internal/user/admin_reads_test.go api/internal/server/router.go
git commit -m "feat(api): expose the admin user activation funnel"
```

---

## Task 9: `GET /admin/users/:id` and `DELETE /admin/users/:id`

**Files:**
- Modify: `api/internal/user/admin_reads.go`, `api/internal/user/admin_handler.go`, `api/internal/server/router.go`
- Test: `api/internal/user/admin_handler_test.go`

**Interfaces:**
- Produces:
  ```go
  type AdminDetail struct {
      AdminRow
      Counts    map[string]int64 `json:"counts"`
      Transfers []Transfer       `json:"transfers"`
      HasAppleToken bool         `json:"has_apple_token"`
  }
  func (r Repository) GetForAdmin(ctx context.Context, id uuid.UUID) (AdminDetail, error)
  ```
  Detail returns **counts only** — never a user's actual meals.

- [ ] **Step 1: Write the failing tests**

```go
func TestGetForAdminPreviewsWhatDeletionDestroys(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner, member := seedUser(t, db), seedUser(t, db)
	g := seedGroup(t, db, owner.ID)
	seedMember(t, db, g.ID, member.ID, time.Now())
	seedFoodLog(t, db, owner.ID)

	d, err := repo.GetForAdmin(context.Background(), owner.ID)
	require.NoError(t, err)

	assert.Equal(t, int64(1), d.Counts["food_logs"])
	require.Len(t, d.Transfers, 1, "the operator must see the group changes hands")
	assert.Equal(t, member.ID, d.Transfers[0].NewOwnerID)
}

func TestGetForAdminUnknownIsNotFound(t *testing.T) {
	db := testDB(t)
	_, err := NewRepository(db).GetForAdmin(context.Background(), uuid.New())
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestAdminDeleteReportsFirebaseSurvival(t *testing.T) {
	db := testDB(t)
	r := newTestAdminRouterWithFailingFirebase(t, db)
	u := seedUser(t, db)

	w := httptest.NewRecorder()
	req := signedAdminRequest(t, http.MethodDelete, "/v1/admin/users/"+u.ID.String(), nil)
	r.ServeHTTP(w, req)

	// 200 with a body, NOT 204: an admin has no self-healing retry, so a
	// surviving identity means the user reappears and the admin must know.
	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"firebase_identity_removed":false`)
}

func TestAdminDeleteUnknownIs404(t *testing.T) {
	db := testDB(t)
	r := newTestAdminRouter(t, db)
	w := httptest.NewRecorder()
	req := signedAdminRequest(t, http.MethodDelete, "/v1/admin/users/"+uuid.NewString(), nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusNotFound, w.Code)
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && go test ./internal/user/ -run 'TestGetForAdmin|TestAdminDelete' -v
```
Expected: FAIL.

- [ ] **Step 3: Implement the detail read**

```go
// adminCountTables are the per-user tables whose row counts the detail panel
// shows. Counts only: a user's actual food logs are their own history, not an
// admin surface.
var adminCountTables = []string{
	"food_logs", "weight_entries", "water_entries", "saved_meals",
	"food_aliases", "pins", "device_tokens", "coach_turns",
	"group_members", "challenge_participants", "feedback", "ai_usage_events",
}

// GetForAdmin returns one user's activation row plus a deletion preview: what
// exists, and what deleting them will hand to somebody else.
func (r Repository) GetForAdmin(ctx context.Context, id uuid.UUID) (AdminDetail, error) {
	var d AdminDetail

	list, err := r.ListForAdmin(ctx)
	if err != nil {
		return d, err
	}
	found := false
	for _, row := range list.Items {
		if row.ID == id {
			d.AdminRow, found = row, true
			break
		}
	}
	if !found {
		return d, ErrNotFound
	}

	d.Counts = map[string]int64{}
	for _, table := range adminCountTables {
		var n int64
		if err := r.db.WithContext(ctx).
			Raw(`SELECT count(*) FROM `+table+` WHERE user_id = ?`, id).Scan(&n).Error; err != nil {
			return d, fmt.Errorf("user: count %s: %w", table, err)
		}
		d.Counts[table] = n
	}

	// Same query the deletion itself runs, so the preview cannot drift from
	// the behaviour — but on a plain session, changing nothing.
	transfers, err := previewTransfers(r.db.WithContext(ctx), id)
	if err != nil {
		return d, err
	}
	d.Transfers = transfers

	var token string
	if err := r.db.WithContext(ctx).
		Raw(`SELECT COALESCE(apple_refresh_token, '') FROM users WHERE id = ?`, id).
		Scan(&token).Error; err != nil {
		return d, fmt.Errorf("user: read apple token presence: %w", err)
	}
	d.HasAppleToken = token != ""

	return d, nil
}
```

In `ownership.go`, split the SELECT out of `transferOwnership` so both share it:

```go
// previewTransfers runs transferOwnership's SELECT without the UPDATE, so the
// detail panel can show exactly what the deletion will do. Sharing the query
// is the point: a hand-written preview would drift from the behaviour.
func previewTransfers(tx *gorm.DB, userID uuid.UUID) ([]Transfer, error) { /* the SELECT from Task 5 */ }
```
and have `transferOwnership` call `previewTransfers` then apply the UPDATEs.

- [ ] **Step 4: Implement the handlers and routes**

```go
// Get serves GET /v1/admin/users/:id.
func (h AdminHandler) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return
	}
	d, err := h.repo.GetForAdmin(c.Request.Context(), id)
	if errors.Is(err, ErrNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": d})
}

// Delete serves DELETE /v1/admin/users/:id.
//
// Returns 200 with a body, not 204, and the body is the point. If the
// Firebase identity survives, the user can sign in, EnsureUser provisions a
// fresh row, and the person the admin deleted REAPPEARS. The self-delete path
// can return a bare 204 because it self-heals; an admin cannot retry through
// the user, so the admin must be told.
func (h AdminHandler) Delete(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return
	}
	res, err := h.svc.Delete(c.Request.Context(), id, DeleteActor{
		IsAdmin: true,
		ID:      c.GetString(bffauth.CtxAdminID),
		Email:   c.GetString(bffauth.CtxAdminEmail),
	})
	if errors.Is(err, ErrNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}
```

Routes:

```go
			adminGroup.GET("/users/:id", usersAdmin.Get)
			adminGroup.DELETE("/users/:id", usersAdmin.Delete)
```

- [ ] **Step 5: Run the full Go suite**

```bash
cd api && go test ./... 2>&1 | tail -25
```
Expected: all packages `ok`, with `internal/user` reporting a materially higher test count than before this plan started.

- [ ] **Step 6: Commit**

```bash
git add api/internal/user/ api/internal/server/router.go
git commit -m "feat(api): add admin user detail and deletion endpoints"
```

---

## Task 10: Portal — signed client methods

**Files:**
- Modify: `apps/web/lib/api/kora-admin.ts`
- Test: `apps/web/lib/api/kora-admin.test.ts`

**Repo:** `tesserix-home`

**Interfaces:**
- Produces:
  ```ts
  export interface KoraUser { id, email, display_name, created_at, onboarded_at, timezone,
    has_targets, log_count, first_log, last_write, ai_calls }
  export interface KoraUserSummary { users, onboarded, ever_logged, tried_never_logged }
  export interface KoraUserList { items: KoraUser[]; summary: KoraUserSummary }
  export interface KoraUserDetail extends KoraUser {
    counts: Record<string, number>; transfers: KoraTransfer[]; has_apple_token: boolean }
  export interface KoraDeleteResult {
    transfers: KoraTransfer[]; firebase_identity_removed: boolean; apple_token_revoked: boolean }
  export async function listKoraUsers(): Promise<KoraUserList>
  export async function getKoraUser(id: string): Promise<KoraUserDetail>
  export async function deleteKoraUser(id: string): Promise<KoraDeleteResult>
  ```

**Field-for-field with Go.** A PATCH client type once promised `email`/`display_name` the endpoint never sent, and the fixture asserted `toEqual` against that fiction. Check each key against Task 8's `AdminRow` JSON tags.

- [ ] **Step 1: Write the failing test**

```ts
it("declares exactly the keys the Go AdminRow emits", async () => {
  koraAdmin.mockResolvedValue({ status: 200, data: { data: {
    items: [{ id: "u1", email: "a@b.com", display_name: "A", created_at: "2026-08-01T00:00:00Z",
      onboarded_at: null, timezone: "Australia/Sydney", has_targets: true,
      log_count: 3, first_log: null, last_write: null, ai_calls: 41 }],
    summary: { users: 1, onboarded: 0, ever_logged: 1, tried_never_logged: 0 },
  }}});
  const page = await listKoraUsers();
  expect(Object.keys(page.items[0]).sort()).toEqual([
    "ai_calls", "created_at", "display_name", "email", "first_log", "has_targets",
    "id", "last_write", "log_count", "onboarded_at", "timezone",
  ]);
  expect(page.summary.tried_never_logged).toBe(0);
});

it("surfaces a 404 from delete as a KoraAdminError", async () => {
  koraAdmin.mockResolvedValue({ status: 404, data: { error: "not_found", message: "user not found" } });
  await expect(deleteKoraUser("u1")).rejects.toBeInstanceOf(KoraAdminError);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && npx vitest run lib/api/kora-admin.test.ts
```
Expected: FAIL — `listKoraUsers is not a function`.

- [ ] **Step 3: Implement**

Follow `listKoraFeedback` exactly (`kora-admin.ts:678`), including its `isKoraFeedbackPage`-style runtime guard:

```ts
export interface KoraTransfer { kind: string; id: string; name: string; new_owner_id: string }

export interface KoraUser {
  id: string; email: string; display_name: string;
  created_at: string; onboarded_at: string | null; timezone: string;
  has_targets: boolean; log_count: number;
  first_log: string | null; last_write: string | null; ai_calls: number;
}

export interface KoraUserSummary {
  users: number; onboarded: number; ever_logged: number; tried_never_logged: number;
}

export interface KoraUserList { items: KoraUser[]; summary: KoraUserSummary }

export interface KoraUserDetail extends KoraUser {
  counts: Record<string, number>;
  transfers: KoraTransfer[];
  has_apple_token: boolean;
}

export interface KoraDeleteResult {
  transfers: KoraTransfer[];
  firebase_identity_removed: boolean;
  apple_token_revoked: boolean;
}

export async function listKoraUsers(): Promise<KoraUserList> {
  const res = await koraAdmin<{ data: KoraUserList }>("GET", "/users");
  if (res.status !== 200) throwKoraError(res.status, res.data, "kora_users_failed");
  return (res.data as { data: KoraUserList }).data;
}

export async function getKoraUser(id: string): Promise<KoraUserDetail> {
  const res = await koraAdmin<{ data: KoraUserDetail }>("GET", `/users/${id}`);
  if (res.status !== 200) throwKoraError(res.status, res.data, "kora_user_failed");
  return (res.data as { data: KoraUserDetail }).data;
}

export async function deleteKoraUser(id: string): Promise<KoraDeleteResult> {
  const res = await koraAdmin<{ data: KoraDeleteResult }>("DELETE", `/users/${id}`);
  if (res.status !== 200) throwKoraError(res.status, res.data, "kora_user_delete_failed");
  return (res.data as { data: KoraDeleteResult }).data;
}
```

- [ ] **Step 4: Run tests**

```bash
cd apps/web && npx vitest run lib/api/kora-admin.test.ts && npx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: tests PASS; tsc count is **18** (unchanged baseline).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api/kora-admin.ts apps/web/lib/api/kora-admin.test.ts
git commit -m "feat(admin): add signed client methods for kora user management"
```

---

## Task 11: Portal — the users list page

**Files:**
- Create: `apps/web/app/admin/apps/kora/users/page.tsx`, `apps/web/app/admin/apps/kora/users/users-table.tsx`
- Modify: `apps/web/lib/products/nav-config.ts`
- Test: `apps/web/app/admin/apps/kora/users/page.test.ts`, `apps/web/lib/products/configs.test.ts`

**Repo:** `tesserix-home`

**Interfaces:**
- Consumes: `listKoraUsers` (Task 10).
- Produces: route `/admin/apps/kora/users`; `koraNav` entry named `Users`.

Follow `app/admin/apps/kora/feedback/page.tsx` for the server-component + error-banner shape. **Never render an empty table on error** — that reads as "no users".

- [ ] **Step 1: Write the failing tests**

```ts
// configs.test.ts
it("has a Users entry pointing at /admin/apps/kora/users", () => {
  const users = koraNav.find((e) => e.name === "Users") as NavEntry;
  expect(users?.href).toBe("/admin/apps/kora/users");
});

// page.test.ts
it("renders the summary strip from the API summary, not from the rows", () => {
  expect(summaryLine({ users: 6, onboarded: 6, ever_logged: 2, tried_never_logged: 1 }))
    .toBe("6 users · 6 onboarded (100%) · 2 ever logged (33%) · 1 tried but never logged");
});

it("shows an explicit error rather than an empty table when the API fails", () => {
  expect(errorMessageFor(500, "boom")).toContain("could not be loaded");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run lib/products/configs.test.ts app/admin/apps/kora/users/page.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add the nav entry**

In `nav-config.ts`, inside `koraNav` after `Feedback`:

```ts
  { name: "Users", href: "/admin/apps/kora/users", icon: Users },
```
Import `Users` from `lucide-react`.

- [ ] **Step 4: Implement `summaryLine` and the page**

```ts
// Percentages are of total users and rounded to whole numbers — with a
// handful of beta users a decimal implies a precision the sample does not
// have.
export function summaryLine(s: KoraUserSummary): string {
  const pct = (n: number) => (s.users === 0 ? 0 : Math.round((n / s.users) * 100));
  return `${s.users} users · ${s.onboarded} onboarded (${pct(s.onboarded)}%) · ` +
    `${s.ever_logged} ever logged (${pct(s.ever_logged)}%) · ` +
    `${s.tried_never_logged} tried but never logged`;
}
```

The page is a server component that calls `listKoraUsers()` in a try/catch and renders `<UsersTable>` or the error banner. Columns, in order: Email, Name, Signed up, Onboarded, Ever logged, First log, Logs, AI calls attempted, Last write, Targets, Timezone.

Two labels are deliberate and must not be "improved":
- **"AI calls attempted"** — it counts calls, not captures, and includes failures.
- **"Last write"** — not "Last seen". Kora records no session event, so this is the last row written. A user who reads their diary daily and logs nothing reads as inactive.

- [ ] **Step 5: Run tests**

```bash
cd apps/web && npx vitest run 2>&1 | tail -6 && npx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: all PASS; tsc **18**.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/admin/apps/kora/users apps/web/lib/products/nav-config.ts apps/web/lib/products/configs.test.ts
git commit -m "feat(admin): add the kora user activation funnel page"
```

---

## Task 12: Portal — detail panel and the delete flow

**Files:**
- Create: `apps/web/app/admin/apps/kora/users/[id]/page.tsx`, `apps/web/app/admin/apps/kora/users/[id]/delete-user.tsx`, `apps/web/app/admin/apps/kora/users/actions.ts`
- Test: `apps/web/app/admin/apps/kora/users/[id]/page.test.ts`

**Repo:** `tesserix-home`

**Interfaces:**
- Consumes: `getKoraUser`, `deleteKoraUser` (Task 10).
- Produces: server action `deleteUser(id: string): Promise<{ ok: true; result: KoraDeleteResult } | { ok: false; message: string }>`.

Follow `feedback/actions.ts` — a server action, not a route handler: `kora-admin.ts` is server-only and binds the acting admin's session identity into the HMAC, and a route handler would be a second public surface needing its own authorization reasoning.

- [ ] **Step 1: Write the failing tests**

```ts
it("requires the typed email to match exactly before enabling delete", () => {
  expect(canDelete("a@b.com", "a@b.com")).toBe(true);
  expect(canDelete("a@b.com", "A@B.com")).toBe(false); // no case-folding on a destructive confirm
  expect(canDelete("a@b.com", "")).toBe(false);
});

it("warns when the firebase identity survived the delete", () => {
  expect(postDeleteWarning({ transfers: [], firebase_identity_removed: false, apple_token_revoked: true }))
    .toContain("can still sign in");
  expect(postDeleteWarning({ transfers: [], firebase_identity_removed: true, apple_token_revoked: true }))
    .toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && npx vitest run app/admin/apps/kora/users
```
Expected: FAIL.

- [ ] **Step 3: Implement the guards**

```ts
// Exact match, deliberately NOT case-folded or trimmed. This is the last
// gate before an irreversible action, and the whole point is that the
// operator reads the address and reproduces it deliberately.
export function canDelete(email: string, typed: string): boolean {
  return email.length > 0 && typed === email;
}

// A surviving Firebase identity means the person REAPPEARS on next sign-in
// with a fresh empty account. The API reports it precisely so the operator
// is not told the deletion was complete when it was not.
export function postDeleteWarning(r: KoraDeleteResult): string | null {
  if (r.firebase_identity_removed) return null;
  return "Account data was deleted, but the Firebase identity survived — this person can still sign in, " +
    "which will create a new empty account. Remove the identity in the Firebase console.";
}
```

- [ ] **Step 4: Implement the action and panel**

```ts
"use server";

export async function deleteUser(id: string) {
  try {
    const result = await deleteKoraUser(id);
    revalidatePath("/admin/apps/kora/users");
    return { ok: true as const, result };
  } catch (err) {
    if (err instanceof KoraAdminError) {
      logger.warn("[kora-users] delete rejected", { status: err.status });
      return { ok: false as const, message: err.message };
    }
    throw err;
  }
}
```

The panel renders the counts table, the transfer list ("Deleting this user hands *Runners* to Jane"), whether an Apple token will be revoked, and the confirmation dialog gated on `canDelete`. The dialog states plainly: **irreversible, no grace period.**

- [ ] **Step 5: Run the full portal suite**

```bash
cd apps/web && npx vitest run 2>&1 | tail -6 && npx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: all PASS; tsc **18**.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/admin/apps/kora/users
git commit -m "feat(admin): add the kora user detail panel and delete flow"
```

---

## Task 13: Ship

- [ ] **Step 1: kora PR**

```bash
cd kora && gh pr create --title "feat(api): admin user management and the shared account deletion engine"
```
Body must name: the migration, that this delivers **#106 slice 2's server half**, the two divergences from #106 (admin `200` body, Redis eviction), and the **Firebase Admin IAM check** from Task 4 Step 6.

- [ ] **Step 2: Verify head SHA, then merge**

```bash
gh api repos/tesserix/kora/pulls/N --jq .head.sha
git rev-parse HEAD   # must match
gh pr merge N --merge --delete-branch
```

- [ ] **Step 3: Deploy kora-api and verify by query, not by badge**

After ArgoCD syncs, confirm the running pod's image tag changed, then:

```bash
kubectl -n global exec global-postgres-1 -c postgres -- psql -U postgres -d kora_db -tAc \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid='ai_usage_events'::regclass AND contype='f';"
```
Expected: `ON DELETE SET NULL`. ArgoCD can report `Synced/Healthy` at a pre-merge revision — hard-refresh and compare revisions with `git merge-base --is-ancestor` before believing it.

- [ ] **Step 4: tesserix-home PR, merge, deploy**

Same head-SHA check. After the main build, refresh the Kargo warehouse and confirm the **pod image tag** changed, not just that the Stage promoted.

- [ ] **Step 5: Verify the surface end to end**

Load `/admin/apps/kora/users` in prod. Confirm the summary strip matches a direct query:

```bash
kubectl -n global exec global-postgres-1 -c postgres -- psql -U postgres -d kora_db -tAc \
  "SELECT count(*) FROM users;
   SELECT count(DISTINCT user_id) FROM food_logs;"
```
An empty table is not a pass — it is the failure mode this page's error banner exists to distinguish.

---

## Self-Review

**Spec coverage:** list (T8, T11) · summary strip with no Active-7d (T8, T11) · "Last write" label (T11) · counts-only detail (T9, T12) · email shown + typed confirm (T10–T12) · no export/pagination (T11) · shared engine two callers (T6, T7, T9) · ownership transfer (T5) · Apple revoke (T6) · Redis eviction (T3, T6) · Firebase divergence (T4, T6, T9, T12) · audit admin-only (T2, T6) · migration (T1) · BFF-only access (T10) · testing rules incl. survivor (T6).

**Placeholders:** one intentional back-reference in Task 9 Step 3 (`previewTransfers` reuses Task 5's SELECT verbatim) — the code is fully written in Task 5 and the split is described exactly.

**Type consistency:** `AdminRow` JSON tags ↔ `KoraUser` keys pinned by an explicit key-set assertion in Task 10 Step 1. `DeleteResult` ↔ `KoraDeleteResult`. `Transfer` ↔ `KoraTransfer`. `ErrNotFound` used consistently in T6/T9.
