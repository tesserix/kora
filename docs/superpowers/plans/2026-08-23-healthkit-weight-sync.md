# HealthKit Weight Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HealthKit weight readings sync into Kora as ordinary `weight_entries` rows with `source: 'healthkit'`, deduplicated so a re-sync cannot duplicate them.

**Architecture:** The device reads new weight samples via an anchored HealthKit query, posts them to `POST /v1/health/sync`, and advances its stored anchor only on success. The server deduplicates on the HealthKit sample UUID, so re-sending a window is harmless — which is the normal path, since a failed sync leaves the anchor unmoved. Weight reuses `weight_entries` verbatim, inheriting R4's provenance and per-instrument trend behaviour.

**Tech Stack:** Go 1.26 + Gin + GORM + Postgres; Expo/React Native with `@kingstinct/react-native-healthkit`.

**Spec:** `docs/superpowers/specs/2026-08-23-health-integrations-design.md`

## Global Constraints

- **Reconcile on the device; store the answer, never the raw claims.** HealthKit's source-priority dedup exists only on-device. See #140 and #327.
- **iOS/HealthKit only.** No Health Connect, no Android.
- **Read-only.** Kora never writes back to HealthKit, so there is no echo loop.
- **Foreground sync only.** On launch and on return from background. No `HKObserverQuery`, no background entitlement.
- **Both weights are kept.** A HealthKit weight and a manual weight on the same day both persist, separated by `source`. Never deduplicate across sources.
- **`local_date` is fixed at write time** in the device's zone (kora#84, `internal/localday`).
- **Composition columns stay NULL.** A HealthKit weight is a weight; a 0 in any composition column is a measurement claim (migration `000039`).
- **HealthKit reads never succeed on a simulator (#187).** Nothing here is verifiable end to end in this setup. Never claim otherwise.
- Single-line conventional commits, no signature, no `Co-Authored-By`. Never run prettier. The repo is PUBLIC — no real health values in commits, comments, fixtures or PR text.

## File Structure

| File | Responsibility |
|---|---|
| `api/internal/database/migrations/000049_weight_entries_hk_uuid.{up,down}.sql` | The `hk_uuid` column and its partial unique index |
| `api/internal/tracking/model.go` | `HKUUID` field on `WeightEntry` |
| `api/internal/tracking/repository.go` | `WeightInput.HKUUID`; conflict-on-`hk_uuid` insert |
| `api/internal/health/model.go` | Wire DTOs for the sync batch |
| `api/internal/health/validate.go` | Per-record validation, drop-and-report |
| `api/internal/health/service.go` | Batch ingest: validate, write, report per record |
| `api/internal/health/handler.go` | `POST /v1/health/sync` |
| `api/internal/server/router.go` | Route wiring |
| `apps/mobile/src/health/anchorStore.ts` | Per-metric anchor persistence |
| `apps/mobile/src/health/syncWeight.ts` | Read weights, map to records, post, advance anchor |
| `apps/mobile/src/health/useHealthSync.ts` | Lifecycle hook: launch + foreground |

---

### Task 1: `hk_uuid` column on `weight_entries`

**Files:**
- Create: `api/internal/database/migrations/000049_weight_entries_hk_uuid.up.sql`
- Create: `api/internal/database/migrations/000049_weight_entries_hk_uuid.down.sql`
- Modify: `api/internal/tracking/model.go`
- Test: `api/internal/database/migrations_hk_uuid_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `weight_entries.hk_uuid` (nullable `uuid`), unique **only where non-null**. `tracking.WeightEntry.HKUUID *uuid.UUID` with json tag `hk_uuid,omitempty`.

- [ ] **Step 1: Write the failing test**

```go
// api/internal/database/migrations_hk_uuid_test.go
package database

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The index must be PARTIAL. Manual and screenshot weigh-ins carry no
// HealthKit UUID, so a plain unique index would let exactly one of them exist
// per user -- the second manual weigh-in would collide on NULL in any database
// that treats NULLs as equal, and the constraint would be silently wrong here
// the day the schema is ported.
func TestWeightEntriesHKUUIDIsUniqueOnlyWhenPresent(t *testing.T) {
	db := testDB(t)
	user := seedUser(t, db)

	hk := uuid.New()
	require.NoError(t, insertWeight(db, user, 70.0, &hk))
	require.Error(t, insertWeight(db, user, 71.0, &hk), "same hk_uuid must be rejected")

	require.NoError(t, insertWeight(db, user, 72.0, nil))
	require.NoError(t, insertWeight(db, user, 73.0, nil), "two NULL hk_uuids must coexist")
}
```

Add the helpers alongside it, matching the style of the existing migration tests in this package:

```go
func insertWeight(db *gorm.DB, userID uuid.UUID, kg float64, hk *uuid.UUID) error {
	return db.Exec(
		`INSERT INTO weight_entries (user_id, weight_kg, logged_at, local_date, source, hk_uuid)
		 VALUES (?, ?, now(), current_date, 'healthkit', ?)`,
		userID, kg, hk,
	).Error
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/database/ -run TestWeightEntriesHKUUID -v`
Expected: FAIL — `column "hk_uuid" of relation "weight_entries" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- 000049_weight_entries_hk_uuid.up.sql
-- kora#30. HealthKit weights arrive as ordinary weight_entries rows with
-- source 'healthkit', so they inherit R4's provenance and per-instrument
-- trend behaviour for free. What they need that a typed weigh-in does not is
-- a stable identity from the system they came from.
--
-- Foreground sync re-sends its whole window whenever a previous sync failed
-- (the device only advances its anchor on success), so the retry path IS the
-- normal path and the write has to be idempotent rather than merely careful.
ALTER TABLE weight_entries ADD COLUMN hk_uuid UUID;

-- PARTIAL, and that is the whole point: manual and screenshot weigh-ins carry
-- no HealthKit UUID. A plain unique index would constrain those NULL rows
-- together in any engine that treats NULLs as equal, capping a user at one
-- hand-typed weigh-in. Postgres does not, but the index says what is meant
-- rather than relying on that.
CREATE UNIQUE INDEX weight_entries_hk_uuid_key
    ON weight_entries (user_id, hk_uuid)
    WHERE hk_uuid IS NOT NULL;
```

```sql
-- 000049_weight_entries_hk_uuid.down.sql
DROP INDEX IF EXISTS weight_entries_hk_uuid_key;
ALTER TABLE weight_entries DROP COLUMN IF EXISTS hk_uuid;
```

Add the model field in `api/internal/tracking/model.go`, on `WeightEntry`:

```go
	// HKUUID is the HealthKit sample's own identifier, present only on rows
	// synced from Apple Health (kora#30). It is what makes a re-sync a no-op
	// rather than a duplicate. NULL for manual, screenshot and InBody rows --
	// they have no HealthKit sample behind them.
	HKUUID *uuid.UUID `gorm:"column:hk_uuid" json:"hk_uuid,omitempty"`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/database/ -run TestWeightEntriesHKUUID -v`
Expected: PASS (both subcases).

- [ ] **Step 5: Mutation-check**

Change the index to a non-partial `CREATE UNIQUE INDEX ... (user_id, hk_uuid)` and re-run. On Postgres the NULL case still passes (NULLs are distinct), so **also** temporarily change the test's two NULL inserts to reuse one `hk_uuid` and confirm the duplicate case fails. Restore both. Record what happened in the commit body — this is an index whose correctness Postgres will not police for you.

- [ ] **Step 6: Commit**

```bash
git add api/internal/database/migrations/000049_* api/internal/tracking/model.go api/internal/database/migrations_hk_uuid_test.go
git commit -m "feat(tracking): add hk_uuid to weight entries for HealthKit dedup (kora#30)"
```

---

### Task 2: Idempotent weight write keyed on `hk_uuid`

**Files:**
- Modify: `api/internal/tracking/repository.go`
- Test: `api/internal/tracking/repository_hk_test.go`

**Interfaces:**
- Consumes: `weight_entries.hk_uuid` from Task 1.
- Produces: `WeightInput.HKUUID *uuid.UUID`. When set, `AddWeightEntry` inserts with `ON CONFLICT (user_id, hk_uuid) DO NOTHING` and returns the already-stored row when the insert is a no-op. When nil, behaviour is byte-for-byte what it is today.

- [ ] **Step 1: Write the failing test**

```go
// api/internal/tracking/repository_hk_test.go
package tracking

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The retry path is the normal path: a failed sync leaves the device anchor
// unmoved, so the next launch re-sends the same window.
func TestAddWeightEntryWithHKUUIDIsIdempotent(t *testing.T) {
	repo := testRepo(t)
	user := seedUser(t, repo)
	hk := uuid.New()

	in := WeightInput{
		WeightKg:  70.4,
		LoggedAt:  time.Now(),
		LocalDate: time.Now(),
		HKUUID:    &hk,
		Composition: BodyComposition{Source: SourceHealthKit},
	}

	first, err := repo.AddWeightEntry(context.Background(), user, in)
	require.NoError(t, err)
	second, err := repo.AddWeightEntry(context.Background(), user, in)
	require.NoError(t, err, "a re-sync must not error")
	require.Equal(t, first.ID, second.ID, "a re-sync must return the stored row, not a new one")

	var count int64
	require.NoError(t, repo.db.Model(&WeightEntry{}).Where("user_id = ?", user).Count(&count).Error)
	require.EqualValues(t, 1, count)
}

// A HealthKit weight and a hand-typed one on the same day are two real
// readings from two instruments (migration 000039). Dedup must not reach
// across sources.
func TestHealthKitWeightDoesNotDedupeAgainstManual(t *testing.T) {
	repo := testRepo(t)
	user := seedUser(t, repo)
	hk := uuid.New()
	now := time.Now()

	_, err := repo.AddWeightEntry(context.Background(), user, WeightInput{
		WeightKg: 70.4, LoggedAt: now, LocalDate: now,
		HKUUID: &hk, Composition: BodyComposition{Source: SourceHealthKit},
	})
	require.NoError(t, err)

	_, err = repo.AddWeightEntry(context.Background(), user, WeightInput{
		WeightKg: 70.9, LoggedAt: now, LocalDate: now,
		Composition: BodyComposition{Source: SourceManual},
	})
	require.NoError(t, err)

	var count int64
	require.NoError(t, repo.db.Model(&WeightEntry{}).Where("user_id = ?", user).Count(&count).Error)
	require.EqualValues(t, 2, count, "both readings must survive")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/tracking/ -run "HKUUID|HealthKitWeight" -v`
Expected: FAIL — `WeightInput` has no field `HKUUID`.

- [ ] **Step 3: Implement**

Add to `WeightInput` in `api/internal/tracking/repository.go`, directly below the existing `ID` field so the two idempotency mechanisms are read together:

```go
	// HKUUID, when set, makes the write idempotent on the HealthKit sample's
	// own identity rather than on a caller-chosen ID. Foreground sync
	// (kora#30) re-sends its window after any failure, so this is the
	// ordinary path, not an error path.
	//
	// Deliberately NOT the deterministic-ID trick onboarding uses: a primary
	// key derived from an external system's UUID is invisible to anyone
	// reading the table, while a named hk_uuid column says what it is.
	HKUUID *uuid.UUID
```

In `AddWeightEntry`, after validation and before the existing insert, branch on it:

```go
	if in.HKUUID != nil {
		e.HKUUID = in.HKUUID
		res := r.db.WithContext(ctx).
			Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "user_id"}, {Name: "hk_uuid"}},
				DoNothing: true,
			}).Create(&e)
		if res.Error != nil {
			return WeightEntry{}, res.Error
		}
		if res.RowsAffected == 0 {
			// Already stored by an earlier sync. Return the existing row so the
			// caller sees the same identity it would have got the first time.
			var existing WeightEntry
			if err := r.db.WithContext(ctx).
				Where("user_id = ? AND hk_uuid = ?", userID, in.HKUUID).
				First(&existing).Error; err != nil {
				return WeightEntry{}, err
			}
			return existing, nil
		}
		return e, nil
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/tracking/ -v`
Expected: PASS, including all pre-existing tests in the package — the nil path must be unchanged.

- [ ] **Step 5: Mutation-check**

Replace `DoNothing: true` with a plain `Create(&e)` and confirm `TestAddWeightEntryWithHKUUIDIsIdempotent` fails on a duplicate-key error. Restore. Then remove `Columns` from the conflict clause and confirm the test still catches a regression. Report both.

- [ ] **Step 6: Commit**

```bash
git add api/internal/tracking/
git commit -m "feat(tracking): dedupe HealthKit weights on the sample uuid (kora#30)"
```

---

### Task 3: Sync wire types and validation

**Files:**
- Create: `api/internal/health/model.go`
- Create: `api/internal/health/validate.go`
- Test: `api/internal/health/validate_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `health.WeightRecord{HKUUID uuid.UUID; WeightKg float64; RecordedAt time.Time; LocalDate string; SourceName string}`
  - `health.SyncRequest{Weights []WeightRecord}`
  - `health.RejectedRecord{HKUUID uuid.UUID; Reason string}`
  - `health.validateWeight(WeightRecord) error`

- [ ] **Step 1: Write the failing test**

```go
// api/internal/health/validate_test.go
package health

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestValidateWeight(t *testing.T) {
	valid := WeightRecord{
		HKUUID: uuid.New(), WeightKg: 70.4,
		RecordedAt: time.Now().Add(-time.Hour), LocalDate: "2026-08-23",
	}
	require.NoError(t, validateWeight(valid))

	t.Run("rejects a missing sample id", func(t *testing.T) {
		r := valid
		r.HKUUID = uuid.Nil
		require.Error(t, validateWeight(r), "without an id the write cannot be idempotent")
	})

	// Same bounds internal/bodyread applies, and for the same reason: the
	// floor catches a decimal misread, the ceiling catches a garbled value.
	// A stored impossible weight deforms every chart drawn from it forever.
	for _, kg := range []float64{0, -1, 19.9, 300.1} {
		r := valid
		r.WeightKg = kg
		require.Error(t, validateWeight(r))
	}

	t.Run("rejects a future reading", func(t *testing.T) {
		r := valid
		r.RecordedAt = time.Now().Add(48 * time.Hour)
		require.Error(t, validateWeight(r))
	})

	t.Run("rejects a malformed local date", func(t *testing.T) {
		r := valid
		r.LocalDate = "23/08/2026"
		require.Error(t, validateWeight(r))
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/health/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement**

```go
// api/internal/health/model.go
// Package health ingests data read from a platform health store (Apple
// HealthKit today -- kora#30) and written into Kora's own tables.
//
// The device reconciles BEFORE posting: HealthKit returns every writing
// source's samples with no deduplication, and only the device can apply
// HealthKit's source-priority rules. Two bugs in this repo came from ignoring
// that (#140, #327). This package therefore trusts that what arrives is
// already reconciled, and its job is validation, identity and storage.
package health

import (
	"time"

	"github.com/google/uuid"
)

// WeightRecord is one weight sample as the device read it.
type WeightRecord struct {
	// HKUUID is the HealthKit sample's identifier and the dedup key. Required:
	// without it a re-sync would duplicate the reading.
	HKUUID uuid.UUID `json:"hk_uuid"`
	WeightKg float64 `json:"weight_kg"`
	RecordedAt time.Time `json:"recorded_at"`
	// LocalDate is the device-local day at capture, "YYYY-MM-DD" (kora#84).
	LocalDate string `json:"local_date"`
	// SourceName is HealthKit's own name for the writing app or device
	// ("Withings", "Apple Watch"). Recorded for provenance, never used to
	// decide whether two readings may share a trend line -- weight_entries.source
	// does that, and it is 'healthkit' for everything here.
	SourceName string `json:"source_name"`
}

type SyncRequest struct {
	Weights []WeightRecord `json:"weights"`
}

// RejectedRecord names one record the batch declined and why. A malformed
// sample must not discard the good ones alongside it.
type RejectedRecord struct {
	HKUUID uuid.UUID `json:"hk_uuid"`
	Reason string    `json:"reason"`
}

type SyncResponse struct {
	Accepted int              `json:"accepted"`
	Rejected []RejectedRecord `json:"rejected"`
}
```

```go
// api/internal/health/validate.go
package health

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Same bounds internal/bodyread uses. 20kg is generous enough for a real adult
// outlier while still catching a decimal misread; 300kg catches an extra digit.
// Neither is a clinical judgement.
const (
	weightMinKg = 20.0
	weightMaxKg = 300.0
	// One day of grace, matching internal/bodyread's reading-date rule: the
	// device's clock and the server's need not agree on the calendar day.
	futureGrace     = 24 * time.Hour
	localDateLayout = "2006-01-02"
)

func validateWeight(r WeightRecord) error {
	if r.HKUUID == uuid.Nil {
		return fmt.Errorf("hk_uuid is required")
	}
	if r.WeightKg < weightMinKg || r.WeightKg > weightMaxKg {
		return fmt.Errorf("weight_kg %.4g outside %g-%g", r.WeightKg, weightMinKg, weightMaxKg)
	}
	if r.RecordedAt.After(time.Now().Add(futureGrace)) {
		return fmt.Errorf("recorded_at is in the future")
	}
	if _, err := time.Parse(localDateLayout, r.LocalDate); err != nil {
		return fmt.Errorf("local_date %q is not YYYY-MM-DD", r.LocalDate)
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/health/ -v`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Widen `weightMinKg` to `0` and confirm the bounds subtest fails; restore. Remove the `uuid.Nil` guard and confirm the missing-id subtest fails; restore. Report both.

- [ ] **Step 6: Commit**

```bash
git add api/internal/health/
git commit -m "feat(health): wire types and validation for platform health sync (kora#30)"
```

---

### Task 4: Batch ingest service

**Files:**
- Create: `api/internal/health/service.go`
- Test: `api/internal/health/service_test.go`

**Interfaces:**
- Consumes: `validateWeight` (Task 3); `tracking.Repository.AddWeightEntry` with `WeightInput.HKUUID` (Task 2).
- Produces: `health.NewService(weights WeightWriter) Service` and `Service.Sync(ctx, userID, SyncRequest) (SyncResponse, error)`, where `WeightWriter` is the one-method interface `AddWeightEntry(ctx, uuid.UUID, tracking.WeightInput) (tracking.WeightEntry, error)`.

- [ ] **Step 1: Write the failing test**

```go
// api/internal/health/service_test.go
package health

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/tracking"
)

type fakeWriter struct {
	calls []tracking.WeightInput
	err   error
}

func (f *fakeWriter) AddWeightEntry(_ context.Context, _ uuid.UUID, in tracking.WeightInput) (tracking.WeightEntry, error) {
	if f.err != nil {
		return tracking.WeightEntry{}, f.err
	}
	f.calls = append(f.calls, in)
	return tracking.WeightEntry{ID: uuid.New()}, nil
}

func rec(kg float64) WeightRecord {
	return WeightRecord{HKUUID: uuid.New(), WeightKg: kg, RecordedAt: time.Now(), LocalDate: "2026-08-23"}
}

// One bad record must not discard the good ones beside it: the device
// re-sends whole windows, so a single malformed sample would otherwise block
// every sync that contained it, forever.
func TestSyncAcceptsGoodRecordsAndReportsBadOnes(t *testing.T) {
	w := &fakeWriter{}
	bad := rec(0) // fails the weight bounds
	resp, err := NewService(w).Sync(context.Background(), uuid.New(), SyncRequest{
		Weights: []WeightRecord{rec(70.4), bad, rec(71.1)},
	})
	require.NoError(t, err)
	require.Equal(t, 2, resp.Accepted)
	require.Len(t, resp.Rejected, 1)
	require.Equal(t, bad.HKUUID, resp.Rejected[0].HKUUID)
	require.Len(t, w.calls, 2)
}

// Every synced row is a weight and nothing else. A 0 in a composition column
// is a measurement claim (migration 000039).
func TestSyncWritesHealthKitSourceAndNoComposition(t *testing.T) {
	w := &fakeWriter{}
	_, err := NewService(w).Sync(context.Background(), uuid.New(), SyncRequest{Weights: []WeightRecord{rec(70.4)}})
	require.NoError(t, err)
	require.Len(t, w.calls, 1)

	in := w.calls[0]
	require.Equal(t, tracking.SourceHealthKit, in.Composition.Source)
	require.NotNil(t, in.HKUUID)
	require.Nil(t, in.Composition.BodyFatPct)
	require.Nil(t, in.Composition.MuscleMassKg)
	require.Nil(t, in.Composition.VisceralFatRating)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/health/ -run TestSync -v`
Expected: FAIL — `NewService` undefined.

- [ ] **Step 3: Implement**

```go
// api/internal/health/service.go
package health

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/tracking"
)

// WeightWriter is the slice of tracking.Repository this package needs. Narrow
// on purpose: it keeps the ingest path testable without a database and makes
// the dependency direction obvious.
type WeightWriter interface {
	AddWeightEntry(ctx context.Context, userID uuid.UUID, in tracking.WeightInput) (tracking.WeightEntry, error)
}

type Service struct{ weights WeightWriter }

func NewService(weights WeightWriter) Service { return Service{weights: weights} }

// Sync ingests one batch. Records are validated and written INDIVIDUALLY: a
// malformed sample is reported and skipped rather than failing the batch,
// because the device re-sends whole windows and one bad record would
// otherwise poison every future sync containing it.
//
// A WRITE failure is different from a validation failure -- it means the
// database is unhappy, not the record -- so it aborts and returns an error,
// leaving the device's anchor unmoved so the window is retried.
func (s Service) Sync(ctx context.Context, userID uuid.UUID, req SyncRequest) (SyncResponse, error) {
	resp := SyncResponse{Rejected: []RejectedRecord{}}

	for _, r := range req.Weights {
		if err := validateWeight(r); err != nil {
			resp.Rejected = append(resp.Rejected, RejectedRecord{HKUUID: r.HKUUID, Reason: err.Error()})
			continue
		}
		localDate, err := time.Parse(localDateLayout, r.LocalDate)
		if err != nil {
			resp.Rejected = append(resp.Rejected, RejectedRecord{HKUUID: r.HKUUID, Reason: err.Error()})
			continue
		}
		hk := r.HKUUID
		if _, err := s.weights.AddWeightEntry(ctx, userID, tracking.WeightInput{
			WeightKg:  r.WeightKg,
			LoggedAt:  r.RecordedAt,
			LocalDate: localDate,
			HKUUID:    &hk,
			// Source is the ONLY composition field set. Everything else stays
			// nil: this is a weight, not a body-composition reading.
			Composition: tracking.BodyComposition{Source: tracking.SourceHealthKit},
		}); err != nil {
			return SyncResponse{}, err
		}
		resp.Accepted++
	}
	return resp, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/health/ -v`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Change the validation `continue` to `return SyncResponse{}, err` and confirm `TestSyncAcceptsGoodRecordsAndReportsBadOnes` fails. Restore. Set `BodyFatPct` to a zero-valued pointer in the `WeightInput` and confirm the composition test fails. Restore. Report both.

- [ ] **Step 6: Commit**

```bash
git add api/internal/health/
git commit -m "feat(health): ingest a batch of platform weight records (kora#30)"
```

---

### Task 5: `POST /v1/health/sync`

**Files:**
- Create: `api/internal/health/handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/health/handler_test.go`

**Interfaces:**
- Consumes: `health.Service.Sync` (Task 4).
- Produces: `health.NewHandler(Service) Handler` with `Handler.Sync(*gin.Context)`, mounted at `POST /v1/health/sync` behind the same auth as the other `/v1` routes.

- [ ] **Step 1: Write the failing test**

```go
// api/internal/health/handler_test.go
package health

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSyncRequiresAuth(t *testing.T) {
	r := testRouterWithoutUser(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBufferString(`{"weights":[]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestSyncReportsRejectedWithoutFailingTheBatch(t *testing.T) {
	r, writer := testRouter(t)
	body, _ := json.Marshal(SyncRequest{Weights: []WeightRecord{rec(70.4), rec(0)}})
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var got struct{ Data SyncResponse `json:"data"` }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, 1, got.Data.Accepted)
	require.Len(t, got.Data.Rejected, 1)
	require.Len(t, writer.calls, 1)
}

func TestSyncRejectsMalformedBody(t *testing.T) {
	r, _ := testRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBufferString(`not json`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}
```

Build `testRouter` and `testRouterWithoutUser` following `api/internal/resolve/handler_test.go`, which sets up a Gin engine with and without a user in context.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/health/ -run TestSync -v`
Expected: FAIL — `NewHandler` undefined.

- [ ] **Step 3: Implement**

```go
// api/internal/health/handler.go
package health

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct{ svc Service }

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

// Sync ingests one batch of platform health records.
//
// Always 200 when the BODY parses, even with every record rejected: the
// per-record verdicts are the payload, and a non-2xx would make the device
// treat a batch of bad samples as a transport failure and re-send it forever.
func (h Handler) Sync(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req SyncRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "body must be a sync request")
		return
	}
	resp, err := h.svc.Sync(c.Request.Context(), uid, req)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, resp)
}
```

In `api/internal/server/router.go`, beside the other `/v1` routes:

```go
		healthHandler := health.NewHandler(health.NewService(trackingRepo))
		v1.POST("/health/sync", healthHandler.Sync)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/health/ ./internal/server/ -v`
Expected: PASS. The server package has a test asserting every `/v1` route requires auth; confirm the new route is picked up by it, and add it to that list if the list is explicit.

- [ ] **Step 5: Mutation-check**

Return `http.StatusUnprocessableEntity` when `len(resp.Rejected) > 0` and confirm `TestSyncReportsRejectedWithoutFailingTheBatch` fails. Restore. Remove the auth guard and confirm `TestSyncRequiresAuth` fails. Restore. Report both.

- [ ] **Step 6: Commit**

```bash
git add api/internal/health/ api/internal/server/router.go
git commit -m "feat(health): expose POST /v1/health/sync (kora#30)"
```

---

### Task 6: Export and account deletion

**Files:**
- Modify: whichever file implements #24's export (find it with `grep -rn "export" api/internal/user/`)
- Modify: the account-deletion path in `api/internal/user/`
- Test: alongside the existing deletion and export tests

**Interfaces:**
- Consumes: `weight_entries.hk_uuid` (Task 1).
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

```go
// Alongside the existing deletion tests in api/internal/user/
//
// Kora's account deletion has been broken twice by data living somewhere the
// deletion path did not reach. A synced HealthKit weight is health data the
// user did not type into Kora, which makes leaving it behind worse, not
// better.
func TestDeleteAccountRemovesHealthKitWeights(t *testing.T) {
	svc, db := testService(t)
	user := seedUser(t, db)
	hk := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (user_id, weight_kg, logged_at, local_date, source, hk_uuid)
		 VALUES (?, 70.4, now(), current_date, 'healthkit', ?)`, user, hk).Error)

	require.NoError(t, svc.Delete(context.Background(), user))

	var count int64
	require.NoError(t, db.Table("weight_entries").Where("user_id = ?", user).Count(&count).Error)
	require.EqualValues(t, 0, count)
}
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd api && go test ./internal/user/ -run TestDeleteAccountRemovesHealthKitWeights -v`

`weight_entries` may already cascade on `user_id`, in which case this **passes immediately**. That is a fine outcome — the test's job is to pin it so a later schema change cannot quietly break it. Record which it was.

- [ ] **Step 3: Implement only if it failed**

If it passed, add no code; the test is the deliverable. If it failed, add the deletion to the same path the rest of the app uses — do not introduce a second deletion mechanism.

- [ ] **Step 4: Confirm the export includes synced weights**

Read #24's export implementation. If it exports `weight_entries` wholesale, synced rows are already included and `hk_uuid` rides along; add an assertion pinning that a `healthkit`-sourced row appears. If it enumerates columns, add `hk_uuid` and `source`.

- [ ] **Step 5: Run the package tests**

Run: `cd api && go test ./internal/user/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/user/
git commit -m "test(user): pin that synced health weights are exported and deleted (kora#30)"
```

---

### Task 7: Device anchor store

**Files:**
- Create: `apps/mobile/src/health/anchorStore.ts`
- Test: `apps/mobile/src/health/__tests__/anchorStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readAnchor(metric: HealthMetric): Promise<string | null>` and `writeAnchor(metric: HealthMetric, anchor: string): Promise<void>`, where `type HealthMetric = "weight"`. Backed by the same storage the app already uses for local state — check `src/offline/` for the established choice and reuse it rather than adding a dependency.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/health/__tests__/anchorStore.test.ts
import { readAnchor, writeAnchor } from "../anchorStore";

// The anchor is DEVICE state, never server state: HKAnchoredObjectQuery
// returns an opaque cursor meaningful only to this device's HealthKit store.
// Sending it to the server would break the moment the user signs in on a
// second phone, which would resume from a cursor that means nothing to it and
// silently skip everything before it.
test("returns null before anything has been synced", async () => {
  expect(await readAnchor("weight")).toBeNull();
});

test("round-trips an anchor", async () => {
  await writeAnchor("weight", "anchor-1");
  expect(await readAnchor("weight")).toBe("anchor-1");
});

test("keeps anchors separate per metric", async () => {
  await writeAnchor("weight", "anchor-weight");
  expect(await readAnchor("steps" as never)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest anchorStore`
Expected: FAIL — cannot resolve `../anchorStore`.

- [ ] **Step 3: Implement**

Write `anchorStore.ts` with a per-metric key prefix (`kora.health.anchor.<metric>`), using the storage module the app already depends on.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest anchorStore`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Drop the metric from the storage key so all metrics share one, and confirm the per-metric test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/health/anchorStore.ts apps/mobile/src/health/__tests__/anchorStore.test.ts
git commit -m "feat(health): persist a per-metric HealthKit anchor on the device (kora#30)"
```

---

### Task 8: Weight sync on the device

**Files:**
- Create: `apps/mobile/src/health/syncWeight.ts`
- Create: `apps/mobile/src/health/useHealthSync.ts`
- Test: `apps/mobile/src/health/__tests__/syncWeight.test.ts`

**Interfaces:**
- Consumes: `readAnchor` / `writeAnchor` (Task 7); `POST /v1/health/sync` (Task 5).
- Produces: `syncWeight(deps): Promise<{ accepted: number; rejected: number }>`, with `deps` supplying the HealthKit query, the poster and the anchor store so the whole thing is testable without HealthKit.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/health/__tests__/syncWeight.test.ts
import { syncWeight } from "../syncWeight";

const sample = (id: string, kg: number) => ({
  uuid: id, quantity: kg, startDate: new Date("2026-08-23T07:00:00Z"), sourceName: "Withings",
});

// The anchor is what makes a failed sync self-healing: leave it where it was
// and the next launch re-sends the same window. Advancing it on failure would
// skip those samples permanently -- there is no second chance, because an
// anchored query only ever moves forward.
test("does not advance the anchor when the post fails", async () => {
  const writeAnchor = jest.fn();
  await expect(syncWeight({
    queryWeights: async () => ({ samples: [sample("a", 70.4)], newAnchor: "anchor-2" }),
    post: async () => { throw new Error("network"); },
    readAnchor: async () => "anchor-1",
    writeAnchor,
  })).rejects.toThrow("network");
  expect(writeAnchor).not.toHaveBeenCalled();
});

test("advances the anchor once the batch is accepted", async () => {
  const writeAnchor = jest.fn();
  const result = await syncWeight({
    queryWeights: async () => ({ samples: [sample("a", 70.4)], newAnchor: "anchor-2" }),
    post: async () => ({ accepted: 1, rejected: [] }),
    readAnchor: async () => "anchor-1",
    writeAnchor,
  });
  expect(result.accepted).toBe(1);
  expect(writeAnchor).toHaveBeenCalledWith("weight", "anchor-2");
});

test("posts nothing and still advances when there are no new samples", async () => {
  const post = jest.fn();
  const writeAnchor = jest.fn();
  await syncWeight({
    queryWeights: async () => ({ samples: [], newAnchor: "anchor-2" }),
    post, readAnchor: async () => "anchor-1", writeAnchor,
  });
  expect(post).not.toHaveBeenCalled();
  expect(writeAnchor).toHaveBeenCalledWith("weight", "anchor-2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest syncWeight`
Expected: FAIL — cannot resolve `../syncWeight`.

- [ ] **Step 3: Implement**

`syncWeight` reads the anchor, runs the anchored query, maps each sample to a `WeightRecord` (`hk_uuid`, `weight_kg`, `recorded_at`, `local_date` from the device's zone via the app's existing local-date helper, `source_name`), posts them, and writes the new anchor **only after** the post resolves. An empty sample list skips the post but still advances.

Then `useHealthSync.ts`: run `syncWeight` on mount and on `AppState` change to `active`, swallowing errors — a failed sync retries next launch and is not worth a modal.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest syncWeight`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Move `writeAnchor` before the `post` call and confirm the failure test fails. Restore. Remove the empty-sample short-circuit and confirm the third test fails. Restore. Report both.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
cd apps/mobile && npx jest --silent && npx tsc --noEmit -p .
git add apps/mobile/src/health/
git commit -m "feat(health): sync HealthKit weights from the device on foreground (kora#30)"
```

---

## Verification

Run before opening the PR:

```bash
cd api && go build ./... && go vet ./... && go test ./...
cd apps/mobile && npx jest --silent && npx tsc --noEmit -p .
```

`internal/coach`, `internal/nutrition/refresh` and `cmd/backfillunits` may fail locally on dev-database drift (missing `starts_on`, `food_refresh_runs`, `diet_tags`). Confirm each fails identically on untouched `main` before attributing it to this work.

## What this plan cannot verify

**HealthKit reads never succeed on a simulator (#187).** No task here is verifiable end to end in this setup. The unit tests are the real coverage; the PR must say so plainly rather than implying a device check happened.

Outstanding after this plan: a device with a real HealthKit weight — ideally written by a third-party scale app — confirming the reading appears in Kora with `source: 'healthkit'`, that a second launch does not duplicate it, and that it does not join a manual reading in the trend.
