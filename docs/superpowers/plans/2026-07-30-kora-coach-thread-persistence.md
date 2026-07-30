# Coach Thread Persistence Implementation Plan (PR 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the coach Q&A thread server-side so it survives app restarts, and expose it via `GET /v1/coach/thread`.

**Architecture:** Store-and-replay only. Each `POST /v1/coach/ask` writes the user's question and Otto's answer as two rows in one transaction; prior turns are **never** fed back into the prompt, so `Ask`'s grounding and all existing guardrail tests keep their exact meaning. Citations are stored in a child table mirroring the `saved_meals`/`saved_meal_items` precedent. `show_support` is never stored — it is recomputed from current signals on every response.

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, testify/require. Tests run against a real Postgres via `TEST_DATABASE_URL`.

## Global Constraints

- **Store + replay only.** Do NOT add prior turns to the prompt in `Service.Ask`. Prompt construction must be byte-for-byte unchanged.
- **Never store `show_support`.** Recompute it per request via `guardrails.AtRisk(SignalsFrom(grounded))`. A stale risk flag must not reappear, and a cleared one must not persist.
- **Never call `BuildNudges` from the thread endpoint** just to get `show_support` — it now performs an extra `WeightSeries` read per call.
- Do NOT persist the two degrade paths in `Ask`: `providerUnavailableText` (nil provider) and `budgetDegradedText` (meter exhausted). Those are transient system states, not conversation turns. Neither the question nor the reply is stored, so nothing is silently swallowed — the user can re-ask.
- A provider error must persist nothing (no orphaned question without an answer).
- Turns are strictly user-scoped. A query must never return another user's turns.
- `role` is exactly `"user"` or `"otto"`.
- Migrations: **before adding `000018`, grep the existing migrations to confirm nothing already creates `coach_turns` or `coach_turn_citations`, then run the whole chain against a fresh database.** A duplicate-table migration is exactly the bug PR #56 fixed.
- Use the repo's model idiom: explicit `TableName()`, `gorm:"type:uuid;default:gen_random_uuid();primaryKey"` on IDs, `ix_`-prefixed indexes in SQL.
- Run Go tests in the **foreground**, never backgrounded.
- `TEST_DATABASE_URL` for this work: `postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable` (container `kora-pg-test`, already migrated — do not recreate or remove it).
- Do NOT run `go run ./cmd/seed`.
- Single-line conventional-commit messages, no body, no `Co-Authored-By`, no signature.
- Work on branch `kora-coach-thread` off `main`.

---

### Task 1: Migration and models

**Files:**
- Create: `api/internal/database/migrations/000018_coach_turns.up.sql`
- Create: `api/internal/database/migrations/000018_coach_turns.down.sql`
- Create: `api/internal/coach/thread_model.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `coach.TurnRole` string type with `TurnRoleUser TurnRole = "user"` and `TurnRoleOtto TurnRole = "otto"`
  - `coach.Turn{ID uuid.UUID, UserID uuid.UUID, Role TurnRole, Text string, CreatedAt time.Time}`, `TableName() == "coach_turns"`
  - `coach.TurnCitation{ID, TurnID uuid.UUID, Label, Value string, Position int}`, `TableName() == "coach_turn_citations"`

- [ ] **Step 1: Confirm no existing migration creates these tables**

Run: `cd api && grep -rn "coach_turns\|coach_turn_citations" internal/database/migrations/`

Expected: no output. If anything matches, STOP and report — do not add a duplicate.

Also confirm `000018` is unused: `ls api/internal/database/migrations/ | grep 000018` must print nothing.

- [ ] **Step 2: Write the up migration**

`api/internal/database/migrations/000018_coach_turns.up.sql`:

```sql
CREATE TABLE coach_turns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_coach_turns_user_created ON coach_turns (user_id, created_at);

CREATE TABLE coach_turn_citations (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id  UUID NOT NULL REFERENCES coach_turns(id) ON DELETE CASCADE,
    label    TEXT NOT NULL,
    value    TEXT NOT NULL,
    position INT NOT NULL
);
CREATE INDEX ix_coach_turn_citations_turn ON coach_turn_citations (turn_id);
```

- [ ] **Step 3: Write the down migration**

`api/internal/database/migrations/000018_coach_turns.down.sql`:

```sql
DROP TABLE IF EXISTS coach_turn_citations;
DROP TABLE IF EXISTS coach_turns;
```

Child first — `coach_turn_citations` references `coach_turns`.

- [ ] **Step 4: Write the models**

`api/internal/coach/thread_model.go`:

```go
package coach

import (
	"time"

	"github.com/google/uuid"
)

// TurnRole identifies who authored a stored coach turn.
type TurnRole string

const (
	TurnRoleUser TurnRole = "user"
	TurnRoleOtto TurnRole = "otto"
)

// Turn is one persisted message in a user's coach thread. Turns are stored
// for replay only — they are never fed back into the model's prompt, so an
// answer is always grounded solely on the deterministic Context computed at
// the time it was asked.
type Turn struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index"`
	Role      TurnRole  `gorm:"not null"`
	Text      string    `gorm:"not null"`
	CreatedAt time.Time
}

func (Turn) TableName() string { return "coach_turns" }

// TurnCitation is one grounding fact cited by an Otto turn. Position
// preserves display order rather than relying on insertion order.
type TurnCitation struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	TurnID   uuid.UUID `gorm:"type:uuid;not null;index"`
	Label    string    `gorm:"not null"`
	Value    string    `gorm:"not null"`
	Position int       `gorm:"not null"`
}

func (TurnCitation) TableName() string { return "coach_turn_citations" }
```

- [ ] **Step 5: Run the full migration chain against a FRESH database**

This is the step that would have caught PR #56's bug. Use a throwaway database so you are testing a fresh chain, not an incremental apply:

```bash
docker exec kora-pg-test psql -U kora -d postgres -c 'DROP DATABASE IF EXISTS kora_migtest WITH (FORCE);' -c 'CREATE DATABASE kora_migtest OWNER kora;'
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_migtest?sslmode=disable' go run ./cmd/migrate
docker exec kora-pg-test psql -U kora -d kora_migtest -tAc "SELECT version, dirty FROM schema_migrations;"
docker exec kora-pg-test psql -U kora -d kora_migtest -tAc "\d coach_turns"
```

Expected: migrate completes with no error; version `18`, dirty `f`; `coach_turns` exists with the five columns.

Then apply to the main test database too, since later tasks' tests need it:

```bash
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go run ./cmd/migrate
docker exec kora-pg-test psql -U kora -d kora -tAc "SELECT version, dirty FROM schema_migrations;"
```

Expected: version `18`, dirty `f`.

Drop the throwaway: `docker exec kora-pg-test psql -U kora -d postgres -c 'DROP DATABASE IF EXISTS kora_migtest WITH (FORCE);'`

- [ ] **Step 6: Commit**

```bash
git add api/internal/database/migrations/000018_coach_turns.up.sql api/internal/database/migrations/000018_coach_turns.down.sql api/internal/coach/thread_model.go
git commit -m "feat(coach): add coach_turns and coach_turn_citations schema"
```

---

### Task 2: Thread repository

**Files:**
- Create: `api/internal/coach/thread_repository.go`
- Test: `api/internal/coach/thread_repository_test.go`

**Interfaces:**
- Consumes: `coach.Turn`, `coach.TurnCitation`, `coach.TurnRole` (Task 1); `coach.Fact{Label, Value string}` (exists in `grounding.go`).
- Produces:
  - `coach.ThreadRepository` with `NewThreadRepository(db *gorm.DB) ThreadRepository`
  - `AppendExchange(ctx context.Context, userID uuid.UUID, question, answer string, citations []Fact) error` — writes the user turn then the otto turn plus its citations, all in ONE transaction
  - `ListRecent(ctx context.Context, userID uuid.UUID, limit int) ([]StoredTurn, error)` — the `limit` most recent turns, returned **oldest→newest**
  - `coach.StoredTurn{Role TurnRole, Text string, CreatedAt time.Time, Citations []Fact}`
  - `const maxThreadTurns = 50`

- [ ] **Step 1: Write the failing tests**

`api/internal/coach/thread_repository_test.go`. Use this package's existing `testDB(t)` and `seedUser(t, db, kcal, protein)` helpers:

```go
package coach

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestThreadRepository_AppendAndListRoundTrip(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	err := repo.AppendExchange(ctx, userID, "what should I eat?", "more protein",
		[]Fact{{Label: "Protein today", Value: "65g"}, {Label: "Kcal left", Value: "750"}})
	require.NoError(t, err)

	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 2)

	require.Equal(t, TurnRoleUser, turns[0].Role)
	require.Equal(t, "what should I eat?", turns[0].Text)
	require.Empty(t, turns[0].Citations, "user turns carry no citations")

	require.Equal(t, TurnRoleOtto, turns[1].Role)
	require.Equal(t, "more protein", turns[1].Text)
	require.Len(t, turns[1].Citations, 2)
	require.Equal(t, "Protein today", turns[1].Citations[0].Label)
	require.Equal(t, "65g", turns[1].Citations[0].Value)
	require.Equal(t, "Kcal left", turns[1].Citations[1].Label)
}

func TestThreadRepository_ListRecentIsOldestFirst(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.AppendExchange(ctx, userID, "q1", "a1", nil))
	require.NoError(t, repo.AppendExchange(ctx, userID, "q2", "a2", nil))

	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 4)
	require.Equal(t, "q1", turns[0].Text)
	require.Equal(t, "a1", turns[1].Text)
	require.Equal(t, "q2", turns[2].Text)
	require.Equal(t, "a2", turns[3].Text)
}

func TestThreadRepository_ListRecentReturnsMostRecentWhenOverLimit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	// 30 exchanges == 60 turns, over the 50 cap.
	for i := 0; i < 30; i++ {
		require.NoError(t, repo.AppendExchange(ctx, userID, "q", "a", nil))
	}

	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, maxThreadTurns, "must cap at the limit")

	// The cap must keep the NEWEST turns, and still return them oldest-first.
	all, err := repo.ListRecent(ctx, userID, 1000)
	require.NoError(t, err)
	require.Len(t, all, 60)
	require.Equal(t, all[len(all)-1].CreatedAt.UnixMicro(), turns[len(turns)-1].CreatedAt.UnixMicro(),
		"last capped turn must be the newest turn overall")
}

func TestThreadRepository_ScopedToUser(t *testing.T) {
	db := testDB(t)
	alice := seedUser(t, db, 2000, 120)
	bob := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.AppendExchange(ctx, alice, "alice q", "alice a", nil))

	turns, err := repo.ListRecent(ctx, bob, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns, "must never return another user's turns")
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/coach/ -run TestThreadRepository -v`

Expected: FAIL — `undefined: NewThreadRepository`.

- [ ] **Step 3: Implement the repository**

`api/internal/coach/thread_repository.go`:

```go
package coach

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// maxThreadTurns is the number of most-recent turns GET /v1/coach/thread
// replays. The table itself is unbounded; this caps the read.
const maxThreadTurns = 50

// StoredTurn is one replayed turn with its citations attached.
type StoredTurn struct {
	Role      TurnRole
	Text      string
	CreatedAt time.Time
	Citations []Fact
}

// ThreadRepository persists and replays a user's coach thread.
type ThreadRepository struct {
	db *gorm.DB
}

func NewThreadRepository(db *gorm.DB) ThreadRepository { return ThreadRepository{db: db} }

// AppendExchange stores a question and its answer as two turns in ONE
// transaction, so a partial write can never leave a question without an
// answer. citations belong to the answer; a user turn never has any.
func (r ThreadRepository) AppendExchange(ctx context.Context, userID uuid.UUID, question, answer string, citations []Fact) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		userTurn := Turn{UserID: userID, Role: TurnRoleUser, Text: question}
		if err := tx.Create(&userTurn).Error; err != nil {
			return err
		}
		ottoTurn := Turn{UserID: userID, Role: TurnRoleOtto, Text: answer}
		if err := tx.Create(&ottoTurn).Error; err != nil {
			return err
		}
		return insertCitations(tx, ottoTurn.ID, citations)
	})
	if err != nil {
		return fmt.Errorf("coach: append exchange: %w", err)
	}
	return nil
}

func insertCitations(tx *gorm.DB, turnID uuid.UUID, citations []Fact) error {
	if len(citations) == 0 {
		return nil
	}
	rows := make([]TurnCitation, len(citations))
	for i, c := range citations {
		rows[i] = TurnCitation{TurnID: turnID, Label: c.Label, Value: c.Value, Position: i}
	}
	return tx.Create(&rows).Error
}

// ListRecent returns the limit most recent turns for userID, oldest first so
// the client renders top-to-bottom without reversing. A user with more than
// limit turns sees their most recent ones, not their first.
func (r ThreadRepository) ListRecent(ctx context.Context, userID uuid.UUID, limit int) ([]StoredTurn, error) {
	rows := []Turn{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("seq DESC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("coach: list recent turns: %w", err)
	}

	// Selected newest-first to apply the cap; flip to oldest-first for display.
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}

	cites, err := r.citationsFor(ctx, rows)
	if err != nil {
		return nil, err
	}

	out := make([]StoredTurn, len(rows))
	for i, t := range rows {
		out[i] = StoredTurn{Role: t.Role, Text: t.Text, CreatedAt: t.CreatedAt, Citations: cites[t.ID]}
	}
	return out, nil
}

// citationsFor loads every citation for turns in one query, keyed by turn id,
// so replaying a thread does not issue an N+1 read per turn.
func (r ThreadRepository) citationsFor(ctx context.Context, turns []Turn) (map[uuid.UUID][]Fact, error) {
	if len(turns) == 0 {
		return map[uuid.UUID][]Fact{}, nil
	}
	ids := make([]uuid.UUID, 0, len(turns))
	for _, t := range turns {
		ids = append(ids, t.ID)
	}

	rows := []TurnCitation{}
	if err := r.db.WithContext(ctx).
		Where("turn_id IN ?", ids).
		Order("turn_id, position").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("coach: list turn citations: %w", err)
	}

	out := make(map[uuid.UUID][]Fact, len(rows))
	for _, c := range rows {
		out[c.TurnID] = append(out[c.TurnID], Fact{Label: c.Label, Value: c.Value})
	}
	return out, nil
}
```

**Order by `seq`, never by `created_at`.** `AppendExchange` writes both turns in one transaction, and Postgres `now()` returns the *transaction-start* timestamp — so a question and its answer get a **byte-identical `created_at`** (verified empirically against this schema). Ordering by `created_at` would leave their relative order undefined, and a UUID `id` tiebreak cannot help because the ids are random. `coach_turns.seq` is a `BIGSERIAL` assigned per insert, so it is strictly increasing and is the only stable ordering key. Turns are selected `seq DESC` so the `LIMIT` keeps the newest, then reversed in Go for display. `created_at` remains what the client shows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/coach/ -run TestThreadRepository -v`

Expected: PASS (4 tests).

**If `TestThreadRepository_AppendAndListRoundTrip` shows the otto turn before the user turn**, the query is ordering by `created_at` somewhere instead of `seq`. Fix the ordering — do NOT reorder the test to match the wrong behaviour. The `seq` column exists precisely because same-transaction rows share a `created_at`; this test is what proves it is being used.

Also note `Turn.Seq` is database-assigned (`gorm:"->;autoIncrement"`, read-only to GORM). Never set it in Go — let the sequence assign it.

- [ ] **Step 5: Commit**

```bash
git add api/internal/coach/thread_repository.go api/internal/coach/thread_repository_test.go
git commit -m "feat(coach): persist and replay coach thread turns with citations"
```

---

### Task 3: Persist on Ask, and serve GET /v1/coach/thread

**Files:**
- Modify: `api/internal/coach/service.go`
- Modify: `api/internal/coach/handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/coach/handler_test.go`, `api/internal/coach/service_test.go`

**Interfaces:**
- Consumes: `ThreadRepository.AppendExchange`, `ThreadRepository.ListRecent`, `maxThreadTurns`, `StoredTurn` (Task 2).
- Produces:
  - `Service` gains a `thread *ThreadRepository` field; `NewService(g *Grounder, p ai.Provider, m ai.Meter, thread *ThreadRepository) *Service` — **4th parameter, nil-tolerant**
  - `Service.Thread(ctx, userID, now, loc) (ThreadResult, error)`
  - `coach.ThreadResult{Turns []StoredTurn, ShowSupport bool}`
  - `Handler.Thread(c *gin.Context)` serving `GET /v1/coach/thread`
  - Wire response shape: `{"data":{"turns":[{"role","text","citations":[{"label","value"}],"created_at"}],"show_support":bool}}`

- [ ] **Step 1: Write the failing tests**

Add to `api/internal/coach/service_test.go`. Build the `Service` the way the neighbouring tests do, adding the new 4th argument:

```go
func TestServiceAsk_PersistsExchange(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "what should I eat?")
	require.NoError(t, err)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 2)
	require.Equal(t, TurnRoleUser, turns[0].Role)
	require.Equal(t, "what should I eat?", turns[0].Text)
	require.Equal(t, TurnRoleOtto, turns[1].Role)
	require.NotEmpty(t, turns[1].Citations, "the answer's grounding facts should be stored")
}

func TestServiceAsk_DoesNotPersistWhenBudgetExhausted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: false}, &threadRepo)

	ans, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "hello")
	require.NoError(t, err)
	require.Equal(t, budgetDegradedText, ans.Text)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns, "a budget-degraded reply is a UI state, not a stored turn")
}

func TestServiceAsk_DoesNotPersistWhenNoProvider(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, nil, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "hello")
	require.NoError(t, err)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns)
}

func TestServiceAsk_PersistsNothingOnProviderError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &errorProvider{}, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "hello")
	require.Error(t, err)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns, "a failed generation must not leave an orphaned question")
}
```

`errorProvider` is a fake whose `GenerateText` returns an error. If this file has no such fake, add one next to `fakeProvider`, matching its style and the `ai.Provider` interface.

Add to `api/internal/coach/handler_test.go`:

```go
func TestHandlerThread_ReturnsStoredTurnsWithSnakeCaseKeys(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"what should I eat?", "more protein", []Fact{{Label: "Protein today", Value: "65g"}}))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Turns []struct {
				Role      string `json:"role"`
				Text      string `json:"text"`
				Citations []struct {
					Label string `json:"label"`
					Value string `json:"value"`
				} `json:"citations"`
			} `json:"turns"`
			ShowSupport bool `json:"show_support"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data.Turns, 2)
	require.Equal(t, "user", body.Data.Turns[0].Role)
	require.Equal(t, "otto", body.Data.Turns[1].Role)
	require.Len(t, body.Data.Turns[1].Citations, 1)
	require.Equal(t, "Protein today", body.Data.Turns[1].Citations[0].Label)

	raw := w.Body.String()
	require.True(t, strings.Contains(raw, `"show_support"`), "raw body must use snake_case show_support, got: %s", raw)
	require.True(t, strings.Contains(raw, `"created_at"`), "raw body must use snake_case created_at, got: %s", raw)
	require.False(t, strings.Contains(raw, `"showSupport"`), "raw body must not use camelCase, got: %s", raw)
}

func TestHandlerThread_EmptyThreadReturnsEmptyList(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/thread", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	// turns must serialise as [] not null, so the client can map over it.
	require.Contains(t, w.Body.String(), `"turns":[]`)
}
```

Also add `r.GET("/v1/coach/thread", h.Thread)` to `newTestRouter` in that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/coach/ -run 'TestServiceAsk_Persists|TestServiceAsk_DoesNot|TestHandlerThread' -v`

Expected: FAIL — `NewService` takes 3 args, `Handler.Thread` undefined.

- [ ] **Step 3: Add persistence to the service**

In `api/internal/coach/service.go`, add the field and constructor parameter:

```go
type Service struct {
	g        *Grounder
	provider ai.Provider
	meter    ai.Meter
	thread   *ThreadRepository
}

// NewService builds a Service over its collaborators. thread may be nil, in
// which case exchanges are answered but not persisted.
func NewService(g *Grounder, p ai.Provider, m ai.Meter, thread *ThreadRepository) *Service {
	return &Service{g: g, provider: p, meter: m, thread: thread}
}
```

In `Ask`, replace the final return with a persist-then-return. Persist ONLY here — after a real generated answer — so the two degrade paths and the provider-error path store nothing:

```go
	answer := Answer{
		Text:        text,
		Citations:   grounded.Facts(),
		ShowSupport: decision.ShowSupport || guardrails.AtRisk(signals),
	}

	// Store the exchange for replay only; prior turns are never fed back
	// into the prompt. A storage failure must not lose an answer the user
	// is already owed, so log and continue rather than returning an error.
	if s.thread != nil {
		if err := s.thread.AppendExchange(ctx, userID, question, answer.Text, answer.Citations); err != nil {
			slog.WarnContext(ctx, "coach: failed to persist thread exchange", "err", err, "user_id", userID)
		}
	}

	return answer, nil
```

Add `"log/slog"` to the imports. Match the repo's existing `slog` usage — if neighbouring code uses plain `slog.Warn` rather than `WarnContext`, follow that.

Add the `Thread` method. It recomputes `show_support` from current signals and must NOT call `BuildNudges`:

```go
// ThreadResult is a replayed thread plus the CURRENT support state.
type ThreadResult struct {
	Turns       []StoredTurn
	ShowSupport bool
}

// Thread replays the user's stored turns. ShowSupport is recomputed from the
// user's current signals rather than stored per turn: a stale risk flag must
// not reappear, and a cleared one must not persist.
func (s *Service) Thread(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (ThreadResult, error) {
	grounded, err := s.g.BuildContext(ctx, userID, now, loc)
	if err != nil {
		return ThreadResult{}, fmt.Errorf("coach: thread: build context: %w", err)
	}

	turns := []StoredTurn{}
	if s.thread != nil {
		turns, err = s.thread.ListRecent(ctx, userID, maxThreadTurns)
		if err != nil {
			return ThreadResult{}, fmt.Errorf("coach: thread: list turns: %w", err)
		}
	}

	return ThreadResult{Turns: turns, ShowSupport: guardrails.AtRisk(SignalsFrom(grounded))}, nil
}
```

- [ ] **Step 4: Add the handler**

In `api/internal/coach/handler.go`:

```go
// threadTurnResponse is one replayed turn in the wire format. Field names are
// snake_case because the mobile client codes against them.
type threadTurnResponse struct {
	Role      TurnRole `json:"role"`
	Text      string   `json:"text"`
	Citations []Fact   `json:"citations"`
	CreatedAt time.Time `json:"created_at"`
}

// Thread replays the authenticated user's stored coach turns.
func (h Handler) Thread(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}

	now := time.Now().UTC()
	loc := user.LocFromContext(c)
	result, err := h.svc.Thread(c.Request.Context(), userID, now, loc)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}

	turns := make([]threadTurnResponse, len(result.Turns))
	for i, t := range result.Turns {
		cites := t.Citations
		if cites == nil {
			cites = []Fact{}
		}
		turns[i] = threadTurnResponse{Role: t.Role, Text: t.Text, Citations: cites, CreatedAt: t.CreatedAt}
	}

	httpx.OK(c, gin.H{"turns": turns, "show_support": result.ShowSupport})
}
```

The `cites == nil` normalisation matters: a nil slice serialises as `null`, and the client maps over this array.

- [ ] **Step 5: Wire the route and constructor**

In `api/internal/server/router.go`, where the coach is wired (~line 169), add the thread repository and the route:

```go
		coachGrounder := coach.NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)
		coachMeter := billing.NewMeter(deps.DB)
		coachThread := coach.NewThreadRepository(deps.DB)
		coachHandler := coach.NewHandler(coach.NewService(&coachGrounder, deps.Provider, coachMeter, &coachThread))
		v1.GET("/coach/nudges", coachHandler.Nudges)
		v1.POST("/coach/ask", coachHandler.Ask)
		v1.GET("/coach/thread", coachHandler.Thread)
```

Then fix every other `NewService(` call site: `grep -rn "NewService(" api/internal/coach/` and add the 4th argument (`nil` where a test does not exercise persistence).

- [ ] **Step 6: Run the coach and server suites**

Run: `cd api && go build ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/coach/ ./internal/server/ -v 2>&1 | tail -40`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/internal/coach/service.go api/internal/coach/handler.go api/internal/coach/service_test.go api/internal/coach/handler_test.go api/internal/server/router.go
git commit -m "feat(coach): persist ask exchanges and serve GET /v1/coach/thread"
```

---

### Task 4: Prompt-immutability guard and full suite

The single most important property of this PR is that persistence did **not** change what the model sees. Pin it.

**Files:**
- Test: `api/internal/coach/service_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the guard test**

The existing `fakeProvider` in this package records or receives the prompts. Extend it (or add a recording fake alongside it, matching its style) so the test can assert on what was passed to `GenerateText`. Then:

```go
func TestServiceAsk_PriorTurnsNeverEnterThePrompt(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	// A prior exchange with a distinctive marker already in the thread.
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"UNIQUEPRIORQUESTION", "UNIQUEPRIORANSWER", nil))

	rec := &recordingProvider{}
	svc := NewService(&g, rec, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "today's question")
	require.NoError(t, err)

	require.NotContains(t, rec.userPrompt, "UNIQUEPRIORQUESTION",
		"store+replay only: a prior turn must never reach the prompt")
	require.NotContains(t, rec.userPrompt, "UNIQUEPRIORANSWER",
		"store+replay only: a prior answer must never reach the prompt")
	require.Contains(t, rec.userPrompt, "today's question")
}
```

Define `recordingProvider` next to the other fakes: it implements `ai.Provider`, captures `systemPrompt` and `userPrompt` on `GenerateText`, and returns a canned answer plus a zero `ai.Usage`.

- [ ] **Step 2: Run it**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/coach/ -run TestServiceAsk_PriorTurnsNeverEnterThePrompt -v`

Expected: PASS immediately — nothing in Task 3 added history to the prompt. **If it fails, prompt construction was changed and must be reverted**; this test is the guard, not a target to satisfy by editing it.

- [ ] **Step 3: Verify the migration chain once more on a fresh database**

```bash
docker exec kora-pg-test psql -U kora -d postgres -c 'DROP DATABASE IF EXISTS kora_migtest WITH (FORCE);' -c 'CREATE DATABASE kora_migtest OWNER kora;'
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_migtest?sslmode=disable' go run ./cmd/migrate
docker exec kora-pg-test psql -U kora -d kora_migtest -tAc "SELECT version, dirty FROM schema_migrations;"
docker exec kora-pg-test psql -U kora -d postgres -c 'DROP DATABASE IF EXISTS kora_migtest WITH (FORCE);'
```

Expected: version `18`, dirty `f`, no error.

- [ ] **Step 4: Run vet and the full suite exactly as CI does**

```bash
cd api
go vet ./...
TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...
```

Expected: `go vet` clean; every package `ok`, zero `FAIL`. Foreground; the `-race` run is slow, let it finish.

- [ ] **Step 5: Commit**

```bash
git add api/internal/coach/service_test.go
git commit -m "test(coach): guard that stored turns never enter the ask prompt"
```

---

## Done criteria

- `go vet ./...` clean; `go test -race -p 1 -count=1 ./...` fully green.
- Fresh-database migration chain reaches version 18, not dirty.
- `GET /v1/coach/thread` returns `{turns:[{role,text,citations,created_at}],show_support}` with snake_case keys, oldest→newest, capped at 50 most recent, `turns` serialising as `[]` when empty.
- An exchange is stored on a real answer; nothing is stored for nil-provider, budget-exhausted, or provider-error paths.
- `show_support` reflects current signals, never stored state.
- Prior turns provably never enter the prompt.
- Turns are user-scoped.
