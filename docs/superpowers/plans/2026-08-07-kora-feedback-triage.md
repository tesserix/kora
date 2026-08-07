# Kora Feedback Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator read and triage the in-app feedback Kora already collects, which today lands in Postgres and is seen by nobody.

**Architecture:** Two read/write endpoints on kora-api's existing `/v1/admin` bffauth group, and one page in the tesserix-home portal that consumes them through the existing HMAC-signed client. No migration — the `feedback` table, its `Kind`/`Status` types and its `(status, created_at)` index all already exist and were written in anticipation of exactly this feature.

**Tech Stack:** Go 1.26 + Gin + GORM (kora-api); Next.js App Router + TypeScript + Vitest (tesserix-home).

**Spec:** `docs/superpowers/specs/2026-08-07-kora-feedback-triage-design.md` (committed `ed72fb3`)

**Two repos, two PRs.** Tasks 1–2 are `kora`. Tasks 3–4 are `tesserix-home` (`/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home`). Tasks 3–4 mock the API in tests, so they can be built before the kora PR deploys — but the page only *works* end-to-end once Tasks 1–2 are merged and kora-api is deployed.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **No migration.** `feedback` (migration `000019_feedback`) already has every column. Adding one is out of scope and a plan violation.
- **Reuse the existing types.** `feedback.Status` is `open` | `in_progress` | `resolved` | `closed` with a working `Status.Valid()`; `feedback.Kind` is `bug` | `feature` with `Kind.Valid()` (`api/internal/feedback/model.go`). **Do not invent a new status set** — the values mirror mark8ly's ticket contract deliberately.
- **User-authored fields are immutable.** `subject`, `description`, `kind` and the device columns are the user's words. Only `status` may ever be written by an operator.
- Go: `go vet ./...` clean; `go test -race -p 1 ./...` — 34 packages. **Repository tests silently SKIP without `TEST_DATABASE_URL`**, so a bare `go test ./...` can look green while never touching the DB. Always run with:
  `export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'` (docker container `kora-pg-test`).
- Go errors wrapped `fmt.Errorf("feedback: ...: %w", err)`. No `panic` outside `main.go`.
- tesserix-home: `cd apps/web && npx vitest run <file>`. **`npx tsc --noEmit` has 18 PRE-EXISTING errors** in `app/admin/apps/homechef/fssai/page.tsx` — they are on `main`, unrelated, and must not be "fixed". Your change must not add a 19th.
- Commits: conventional prefix, **single line**, no body, no trailers, no signature.
- **Every task ends with a mutation step.** Break the implementation, name the exact test that must fail. If a mutation reddens more than its named test, it proved nothing — narrow it.

---

## File Structure

**kora — create:**
- `api/internal/feedback/reads.go` — list params/result types, the list query, and the status update. Kept out of `repository.go` (which owns `Create`) so the capture path and the admin path stay separately readable, mirroring how `admin/` splits `repository.go` from `reads.go`.
- `api/internal/feedback/reads_test.go`
- `api/internal/feedback/admin_handler.go` — the two admin HTTP handlers.
- `api/internal/feedback/admin_handler_test.go`

**kora — modify:**
- `api/internal/server/router.go:147-153` — two routes on the existing `adminGroup`.

**tesserix-home — create:**
- `apps/web/app/admin/apps/kora/feedback/page.tsx` — server component, offset paging via links.
- `apps/web/app/admin/apps/kora/feedback/feedback-table.tsx` — client component (needs the status control).
- `apps/web/app/admin/apps/kora/feedback/actions.ts` — the status server action.
- `apps/web/app/admin/apps/kora/feedback/page.test.ts`

**tesserix-home — modify:**
- `apps/web/lib/api/kora-admin.ts` — two client functions + their types/guards.
- `apps/web/lib/products/nav-config.ts` — one `koraNav` entry.

---

### Task 1: Feedback admin repository — list and status update

**Files:**
- Create: `api/internal/feedback/reads.go`
- Create: `api/internal/feedback/reads_test.go`

**Interfaces:**
- Consumes: `Feedback`, `Kind`, `Status`, `Kind.Valid()`, `Status.Valid()` from `api/internal/feedback/model.go`; `Repository` / `NewRepository(db)` from `repository.go`.
- Produces, relied on by Task 2:
  - `type ListParams struct { Status *Status; Kind *Kind; Limit, Offset int }`
  - `type Item struct { Feedback; Email string; DisplayName string }`
  - `type ListResult struct { Items []Item; Total int64 }`
  - `func (r Repository) List(ctx context.Context, p ListParams) (ListResult, error)`
  - `func (r Repository) UpdateStatus(ctx context.Context, id uuid.UUID, s Status) (Feedback, error)`
  - `var ErrNotFound = errors.New("feedback: not found")`
  - `const DefaultLimit = 50`, `const MaxLimit = 100`

- [ ] **Step 1: Write the failing tests**

Read `api/internal/feedback/repository_test.go` first and match its DB-fixture helpers exactly — do not invent a new harness. Create `api/internal/feedback/reads_test.go`:

```go
package feedback

// Seeds two users and four feedback rows spanning both kinds and two
// statuses. Returns the ids in insertion order.
// Reuse whatever DB setup repository_test.go already provides.

func TestListReturnsNewestFirst(t *testing.T) {
	// Seed two rows with DISTINCT created_at. A single-row fixture proves
	// nothing about ordering.
	// Assert items[0] is the NEWER row.
}

func TestListFiltersByStatus(t *testing.T) {
	// Seed one StatusOpen and one StatusResolved for the same user.
	// Filtered call (Status=&open) returns exactly 1, and it is the open one.
	// UNFILTERED call returns 2. That second assertion is the counterweight:
	// without it, a repository that returns nothing at all would pass.
}

func TestListFiltersByKind(t *testing.T) {
	// Same shape as status: filtered returns only the bug; unfiltered returns both.
}

func TestListTotalIsUnpaginatedCount(t *testing.T) {
	// Seed 3 rows, call with Limit=1.
	// len(items) == 1 AND Total == 3.
	// A Total that equals len(items) is the classic pagination bug — assert
	// both halves or this test cannot catch it.
}

func TestListJoinsSubmitterIdentity(t *testing.T) {
	// Seed a user with a known email and display_name; assert both surface.
}

func TestListToleratesEmptyDisplayName(t *testing.T) {
	// Seed a user whose display_name is '' (the pre-seeding-fix state).
	// Assert the row still returns, Email is populated, DisplayName is "".
	// Assert a NON-empty display name in the same suite (the test above) so
	// this is tolerance, not a join that never populates anything.
}

func TestUpdateStatusPersistsAndReturnsRow(t *testing.T) {
	// Seed StatusOpen, update to StatusResolved.
	// Returned row has StatusResolved, and a re-read confirms it persisted.
}

func TestUpdateStatusLeavesUserAuthoredFieldsIntact(t *testing.T) {
	// Update the status, then assert subject/description/kind are unchanged
	// AND that status DID change — assert the change first in the same test,
	// so this is immutability rather than a no-op update.
}

func TestUpdateStatusUnknownIDReturnsErrNotFound(t *testing.T) {
	// errors.Is(err, ErrNotFound)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' && go test -race -run "TestList|TestUpdateStatus" ./internal/feedback/...`
Expected: FAIL — `List`, `UpdateStatus`, `ListParams` undefined.

> If these SKIP rather than fail, `TEST_DATABASE_URL` is not set. A skip is not a pass — fix the env before continuing.

- [ ] **Step 3: Write the implementation**

Create `api/internal/feedback/reads.go`:

```go
package feedback

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ErrNotFound is returned by UpdateStatus when no feedback row has the id.
// The handler maps it to 404; every other error is a 500.
var ErrNotFound = errors.New("feedback: not found")

// DefaultLimit and MaxLimit bound a page. MaxLimit is lower than admin's 200
// because a feedback row carries a free-text description, so a page is far
// heavier than a food or an audit event.
const (
	DefaultLimit = 50
	MaxLimit     = 100
)

// ListParams filters the admin list. Nil Status/Kind mean "no filter" — an
// unset filter and an invalid one are different things, and the handler
// rejects the invalid case before it reaches here.
type ListParams struct {
	Status *Status
	Kind   *Kind
	Limit  int
	Offset int
}

// Item is one row plus the submitter identity the feedback table deliberately
// does not store. Without the join a row is unactionable: you cannot tell
// whether "it crashed" came from a tester you can reach or one you cannot.
type Item struct {
	Feedback
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

// ListResult carries the page plus the count of ALL matching rows, not the
// page length, so the portal can render "showing 50 of 812".
type ListResult struct {
	Items []Item `json:"items"`
	Total int64  `json:"total"`
}

func clampLimit(limit int) int {
	switch {
	case limit <= 0:
		return DefaultLimit
	case limit > MaxLimit:
		// Clamp to MaxLimit, NOT DefaultLimit: the portal computes
		// offset = page * the limit IT asked for, so silently falling back
		// to a smaller page would make the next offset skip rows that Total
		// truthfully says exist.
		return MaxLimit
	default:
		return limit
	}
}

// List returns one page of feedback, newest first, with the submitter joined.
func (r Repository) List(ctx context.Context, p ListParams) (ListResult, error) {
	p.Limit = clampLimit(p.Limit)
	if p.Offset < 0 {
		p.Offset = 0
	}

	q := r.db.WithContext(ctx).Model(&Feedback{})
	if p.Status != nil {
		q = q.Where("feedback.status = ?", string(*p.Status))
	}
	if p.Kind != nil {
		q = q.Where("feedback.kind = ?", string(*p.Kind))
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return ListResult{}, fmt.Errorf("feedback: count: %w", err)
	}

	var items []Item
	// Order by (created_at DESC, id DESC), never created_at alone. created_at
	// is not unique — two submissions inside the same clock tick, or seeded
	// fixtures, share a timestamp — and an unstable sort makes a row appear on
	// two consecutive pages while another is skipped entirely. This mirrors
	// admin.ListEvents, which documents the same trap.
	//
	// The status filter above is what finally uses ix_feedback_status_created
	// (migration 000019), an index nothing has queried until now.
	if err := q.
		Select("feedback.*, users.email AS email, COALESCE(users.display_name, '') AS display_name").
		Joins("JOIN users ON users.id = feedback.user_id").
		Order("feedback.created_at DESC, feedback.id DESC").
		Limit(p.Limit).Offset(p.Offset).
		Find(&items).Error; err != nil {
		return ListResult{}, fmt.Errorf("feedback: list: %w", err)
	}
	return ListResult{Items: items, Total: total}, nil
}

// UpdateStatus writes ONLY the status column. subject, description, kind and
// the device context are the user's own words and must never be rewritten by
// an operator, so they are not in the update set at all — the strongest
// available guarantee, versus relying on callers to pass them unchanged.
func (r Repository) UpdateStatus(ctx context.Context, id uuid.UUID, s Status) (Feedback, error) {
	res := r.db.WithContext(ctx).Model(&Feedback{}).
		Where("id = ?", id).
		Update("status", string(s))
	if res.Error != nil {
		return Feedback{}, fmt.Errorf("feedback: update status: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Feedback{}, ErrNotFound
	}

	var out Feedback
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&out).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return Feedback{}, ErrNotFound
		}
		return Feedback{}, fmt.Errorf("feedback: reload after update: %w", err)
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' && go test -race ./internal/feedback/...`
Expected: PASS.

- [ ] **Step 5: Run the mutations**

Mutation A — delete the `if p.Status != nil` block from `List`.
Expected: **exactly** `TestListFiltersByStatus` FAILS; `TestListReturnsNewestFirst` and the unfiltered assertions stay green.

Mutation B — change `Update("status", ...)` to also write `Update("subject", "hacked")` (use `Updates(map[string]any{...})`).
Expected: **exactly** `TestUpdateStatusLeavesUserAuthoredFieldsIntact` FAILS.

Revert both before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/feedback/reads.go api/internal/feedback/reads_test.go
git commit -m "feat(api): add feedback list and status-update reads for the admin surface"
```

---

### Task 2: Feedback admin handlers and routes

**Files:**
- Create: `api/internal/feedback/admin_handler.go`
- Create: `api/internal/feedback/admin_handler_test.go`
- Modify: `api/internal/server/router.go` (the `adminGroup` block at ~line 147)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `func NewAdminHandler(r Repository) AdminHandler`, with methods `List(c *gin.Context)` and `UpdateStatus(c *gin.Context)`.

- [ ] **Step 1: Write the failing tests**

Read `api/internal/feedback/handler_test.go` and `api/internal/admin/reads_test.go` first; match their Gin test harness rather than inventing one. Create `api/internal/feedback/admin_handler_test.go` covering:

```go
// GET
// - 200 with {"data":{"items":[...],"total":N}} for no filters.
// - status=open filters; status=nonsense is 400 with code "invalid_input".
// - kind=bug filters; kind=nonsense is 400.
// - limit=abc is 400; limit=-1 is 400; offset=-1 is 400.
// - limit=500 does NOT 400 — it clamps. Assert len(items) <= MaxLimit.
//
// PATCH
// - 200 sets the status and returns the updated row.
// - {"status":"nonsense"} is 400 and the row is UNCHANGED afterwards
//   (re-read it — a handler that 400s after writing would pass a
//   status-code-only assertion).
// - a well-formed but unknown UUID is 404.
// - a non-UUID :id is 400, not 404.
```

**Assert the invalid-filter cases return 400 and NOT 200-with-all-rows.** A filter that is silently ignored is the specific failure this endpoint must not have: the operator believes they are looking at a filtered list and are not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' && go test -race ./internal/feedback/...`
Expected: FAIL — `NewAdminHandler` undefined.

- [ ] **Step 3: Write the implementation**

Create `api/internal/feedback/admin_handler.go`:

```go
package feedback

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

// AdminHandler serves the bffauth-protected /v1/admin/feedback endpoints.
// Separate from Handler (the user-facing capture endpoint) because the two
// have different auth, different callers and no shared request shapes.
type AdminHandler struct {
	repo Repository
}

func NewAdminHandler(r Repository) AdminHandler { return AdminHandler{repo: r} }

// intParam parses a non-negative integer query param. An absent param is 0
// (meaning "unset"), a malformed or negative one is an error the caller turns
// into a 400 — never a silently-ignored filter.
func intParam(c *gin.Context, name string) (int, error) {
	raw := c.Query(name)
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, strconv.ErrRange
	}
	return v, nil
}

// List serves GET /v1/admin/feedback?status=&kind=&limit=&offset=.
func (h AdminHandler) List(c *gin.Context) {
	limit, err := intParam(c, "limit")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "limit must be a non-negative integer")
		return
	}
	offset, err := intParam(c, "offset")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "offset must be a non-negative integer")
		return
	}

	params := ListParams{Limit: limit, Offset: offset}

	// An unrecognised filter value is a 400, NOT an ignored filter. Silently
	// dropping it would show the operator an unfiltered list while the UI
	// claims it is filtered.
	if raw := c.Query("status"); raw != "" {
		s := Status(raw)
		if !s.Valid() {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "status must be one of open, in_progress, resolved, closed")
			return
		}
		params.Status = &s
	}
	if raw := c.Query("kind"); raw != "" {
		k := Kind(raw)
		if !k.Valid() {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "kind must be one of bug, feature")
			return
		}
		params.Kind = &k
	}

	result, err := h.repo.List(c.Request.Context(), params)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, result)
}

type updateStatusRequest struct {
	Status Status `json:"status"`
}

// UpdateStatus serves PATCH /v1/admin/feedback/:id. Status is the only
// mutable field.
func (h AdminHandler) UpdateStatus(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return
	}

	var req updateStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "body must be {\"status\": \"...\"}")
		return
	}
	if !req.Status.Valid() {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "status must be one of open, in_progress, resolved, closed")
		return
	}

	updated, err := h.repo.UpdateStatus(c.Request.Context(), id, req.Status)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "feedback not found")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, updated)
}
```

- [ ] **Step 4: Register the routes**

In `api/internal/server/router.go`, inside the existing `adminGroup` block (the one created by `r.Group("/v1/admin", bffauth.Middleware(deps.BFFHMACKey, 0))`), add after the existing food/event routes:

```go
		feedbackAdmin := feedback.NewAdminHandler(feedback.NewRepository(deps.DB))
		adminGroup.GET("/feedback", feedbackAdmin.List)
		adminGroup.PATCH("/feedback/:id", feedbackAdmin.UpdateStatus)
```

`feedback` is already imported in this file (line ~21) for the capture route — do not add a duplicate import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' && go vet ./... && go test -race -p 1 ./...`
Expected: 34 packages, all pass.

- [ ] **Step 6: Run the mutations**

Mutation A — in `List`, replace the `!s.Valid()` guard with `if false`.
Expected: **exactly** the invalid-status test FAILS; the valid-status filter test stays green.

Mutation B — in `UpdateStatus`, delete the `errors.Is(err, ErrNotFound)` branch so it falls through to `RespondServiceError`.
Expected: **exactly** the unknown-UUID 404 test FAILS.

Revert both before committing.

- [ ] **Step 7: Commit and open the PR**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/feedback/admin_handler.go api/internal/feedback/admin_handler_test.go api/internal/server/router.go
git commit -m "feat(api): expose feedback list and status triage on the admin surface"
```

---

### Task 3: Portal client functions

**Repo:** `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home`

**Files:**
- Modify: `apps/web/lib/api/kora-admin.ts`
- Test: `apps/web/lib/api/kora-admin.test.ts`

**Interfaces:**
- Consumes: `koraAdmin<T>(method, path, {search, body})`, `throwKoraError`, `KoraAdminError`, `assertUuid`, `logger` — all already in this file. Read `listKoraEvents` (~line 584) and copy its shape.
- Produces:
  - `interface KoraFeedback { id, user_id, kind, subject, description, status, app_version, platform, os_version, device_model, created_at, email, display_name }` (all `string` except none — `created_at` is an ISO string)
  - `interface KoraFeedbackPage { items: KoraFeedback[]; total: number }`
  - `listKoraFeedback(params: { status?: string; kind?: string; limit?: number; offset?: number }): Promise<KoraFeedbackPage>`
  - `updateKoraFeedbackStatus(id: string, status: string): Promise<KoraFeedback>`

- [ ] **Step 1: Write the failing tests**

Read the existing `kora-admin.test.ts` first and match how it stubs `koraAdmin`/fetch. Add tests asserting:

```
- listKoraFeedback sends GET /feedback with the status/kind/limit/offset search params it was given.
- listKoraFeedback returns the page on a 200 whose body is {data:{items,total}}.
- listKoraFeedback throws KoraAdminError when the 200 body does NOT match the
  expected shape (e.g. {data:{}}). Assert the well-formed case in the same
  suite first, so this is shape-rejection and not a function that always throws.
- listKoraFeedback throws on a non-200.
- updateKoraFeedbackStatus PATCHes /feedback/<id> with {status}.
- updateKoraFeedbackStatus rejects a non-UUID id BEFORE issuing a request —
  assert the transport was not called at all.
```

That last one matters: `koraAdmin` signs the raw path while `fetch` percent-encodes and Go percent-decodes, so a non-ASCII-safe segment makes the signature disagree and yields a 401 that does not read as "bad id". `assertUuid` already exists in this file for exactly this.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run lib/api/kora-admin.test.ts`
Expected: FAIL — `listKoraFeedback` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/web/lib/api/kora-admin.ts`:

```ts
export interface KoraFeedback {
  id: string;
  user_id: string;
  kind: string;
  subject: string;
  description: string;
  status: string;
  app_version: string;
  platform: string;
  os_version: string;
  device_model: string;
  created_at: string;
  /** Joined from users — the feedback table stores no submitter identity. */
  email: string;
  /** May be "" for users created before display-name seeding landed. */
  display_name: string;
}

export interface KoraFeedbackPage {
  items: KoraFeedback[];
  total: number;
}

function isKoraFeedbackPage(value: unknown): value is KoraFeedbackPage {
  if (!value || typeof value !== "object") return false;
  const page = value as { items?: unknown; total?: unknown };
  return Array.isArray(page.items) && typeof page.total === "number";
}

function isKoraFeedback(value: unknown): value is KoraFeedback {
  if (!value || typeof value !== "object") return false;
  const f = value as { id?: unknown; status?: unknown };
  return typeof f.id === "string" && typeof f.status === "string";
}

/** `GET /v1/admin/feedback` — in-app feedback, newest first. */
export async function listKoraFeedback(params: {
  status?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}): Promise<KoraFeedbackPage> {
  const res = await koraAdmin<{ data: KoraFeedbackPage }>("GET", "/feedback", {
    search: {
      status: params.status ?? "",
      kind: params.kind ?? "",
      limit: params.limit ? String(params.limit) : "",
      offset: params.offset ? String(params.offset) : "",
    },
  });
  if (res.status !== 200) throwKoraError(res.status, res.data, "list_feedback_failed");

  const page = res.data?.data;
  if (!isKoraFeedbackPage(page)) {
    logger.warn("[kora-admin] GET /feedback -> 200 with an unexpected body shape");
    throw new KoraAdminError(200, "unexpected_response_shape", "feedback response did not match the expected shape");
  }
  return page;
}

/** `PATCH /v1/admin/feedback/:id` — status is the only mutable field. */
export async function updateKoraFeedbackStatus(id: string, status: string): Promise<KoraFeedback> {
  assertUuid(id);
  const res = await koraAdmin<{ data: KoraFeedback }>("PATCH", `/feedback/${id}`, {
    body: { status },
  });
  if (res.status !== 200) throwKoraError(res.status, res.data, "update_feedback_failed");

  const updated = res.data?.data;
  if (!isKoraFeedback(updated)) {
    logger.warn("[kora-admin] PATCH /feedback -> 200 with an unexpected body shape");
    throw new KoraAdminError(200, "unexpected_response_shape", "feedback response did not match the expected shape");
  }
  return updated;
}
```

> Check `koraAdmin`'s options type before relying on `body` — if it names the field differently (e.g. `json`), use whatever `createKoraFood`/`updateKoraFood` already pass. Do not change `koraAdmin` itself.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run lib/api/kora-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the mutation**

Remove the `assertUuid(id)` call from `updateKoraFeedbackStatus`.
Expected: **exactly** the non-UUID test FAILS; every other test stays green.

Revert before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git add apps/web/lib/api/kora-admin.ts apps/web/lib/api/kora-admin.test.ts
git commit -m "feat(admin): add Kora feedback list and status client functions"
```

---

### Task 4: Portal feedback page

**Repo:** `/Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home`

**Files:**
- Create: `apps/web/app/admin/apps/kora/feedback/page.tsx`
- Create: `apps/web/app/admin/apps/kora/feedback/feedback-table.tsx`
- Create: `apps/web/app/admin/apps/kora/feedback/actions.ts`
- Create: `apps/web/app/admin/apps/kora/feedback/page.test.ts`
- Modify: `apps/web/lib/products/nav-config.ts` (`koraNav`)

**Interfaces:**
- Consumes: `listKoraFeedback`, `updateKoraFeedbackStatus`, `KoraFeedback`, `KoraAdminError` from Task 3.

- [ ] **Step 1: Read the two files you are modelling on**

Read `apps/web/app/admin/apps/kora/audit/page.tsx` (server component, offset paging by link, `firstParam` guard, `loadError` capture) and `apps/web/app/admin/apps/kora/foods/actions.ts` (server actions, and the comment explaining why server actions rather than route handlers — the acting admin's identity is bound into the HMAC).

Follow both. Do not introduce a route handler.

- [ ] **Step 2: Write the failing nav test**

In `apps/web/lib/products/configs.test.ts`, add to the existing `kora nav` describe:

```ts
it("has a Feedback entry pointing at /admin/apps/kora/feedback", () => {
  const fb = koraNav.find((entry) => entry.name === "Feedback") as { href: string } | undefined;
  expect(fb).toBeDefined();
  expect(fb?.href).toBe("/admin/apps/kora/feedback");
});
```

The existing `never links out of the Kora product surface` test already guards containment — your new entry must satisfy it.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && npx vitest run lib/products/configs.test.ts`
Expected: FAIL — no Feedback entry.

- [ ] **Step 4: Add the nav entry**

In `apps/web/lib/products/nav-config.ts`, add to `koraNav` after `Audit trail` (and before the comment block explaining the absent Service health entry):

```ts
  { name: "Feedback", href: "/admin/apps/kora/feedback", icon: MessageSquare },
```

`MessageSquare` is already imported in this file.

- [ ] **Step 5: Write the server action**

Create `apps/web/app/admin/apps/kora/feedback/actions.ts`:

```ts
"use server";

// Server action, not a route handler — same reasoning as the food mutations
// in ../foods/actions.ts: lib/api/kora-admin.ts is server-only by
// construction and binds the ACTING ADMIN's session identity into the HMAC.
// A route handler would be a second public surface needing its own
// authorization reasoning; a server action has no URL of its own.

import { revalidatePath } from "next/cache";

import { KoraAdminError, updateKoraFeedbackStatus } from "@/lib/api/kora-admin";
import { logger } from "@/lib/logger";

export async function setFeedbackStatus(
  id: string,
  status: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await updateKoraFeedbackStatus(id, status);
    revalidatePath("/admin/apps/kora/feedback");
    return { ok: true };
  } catch (err) {
    if (err instanceof KoraAdminError) {
      logger.warn("[kora-feedback] status update rejected", { status: err.status });
      return { ok: false, message: err.message };
    }
    throw err;
  }
}
```

> Match `../foods/actions.ts`'s actual return convention — if it uses a shared `ActionState` type, use that instead of the inline union above rather than introducing a second convention.

- [ ] **Step 6: Write the page and table**

`page.tsx` — server component, mirroring `audit/page.tsx`:
- `PAGE_SIZE = 50`.
- `firstParam()` guard for repeated query keys (`?status=a&status=b` would otherwise stringify to `"a,b"`).
- Read `status`, `kind`, `offset` from `searchParams`.
- **Default `status` to `"open"` when the param is absent.** The operator's question on opening this page is "what needs my attention", not "what has ever been submitted". Provide an explicit "All" filter option that sets `status=""` so the default is escapable.
- Call `listKoraFeedback`, capture `KoraAdminError` into `loadError` and render it rather than throwing.
- Render `<FeedbackTable items={items} />`.
- Paging as plain links via a `buildHref({status, kind, offset})` helper, so the page stays server-rendered and back-button-correct.

`feedback-table.tsx` — `"use client"`, because the status control mutates:
- One row per item: kind badge, subject, submitter (`display_name || email` — the fallback matters, `display_name` may be `""`), relative age, and a status `<select>` of the four values.
- Row expands in place to show the full `description` plus the device context (`app_version`, `platform`, `os_version`, `device_model`). Bug reports run long; truncating at the row loses the report.
- On status change call `setFeedbackStatus(id, next)`; on `{ok:false}` surface the message and revert the control to its previous value.

- [ ] **Step 7: Write the page test**

Create `page.test.ts` modelled on `apps/web/app/admin/apps/kora/foods/page.test.ts`. Cover:
- `buildHref` preserves `status` and `kind` while changing `offset` — a pager that drops the active filters silently widens the list under the operator.
- The default status is `open` when the param is absent, and `""` (all) is respected when explicitly set. Assert the explicit-empty case, or a "default to open" implementation that ignores the param entirely would pass.

- [ ] **Step 8: Run everything**

Run: `cd apps/web && npx vitest run lib/products/configs.test.ts app/admin/apps/kora/feedback/page.test.ts lib/api/kora-admin.test.ts`
Expected: PASS.

Run: `cd apps/web && npx tsc --noEmit`
Expected: the **same 18 pre-existing errors** in `homechef/fssai/page.tsx` and no others. If you see a 19th, it is yours — fix it.

- [ ] **Step 9: Run the mutation**

In `page.tsx`, change the default status from `"open"` to `""`.
Expected: **exactly** the default-status test FAILS; the `buildHref` tests stay green.

Revert before committing.

- [ ] **Step 10: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git add apps/web/app/admin/apps/kora/feedback apps/web/lib/products/nav-config.ts apps/web/lib/products/configs.test.ts
git commit -m "feat(admin): add the Kora feedback triage page"
```

---

## Verification after both PRs merge

The portal talks to the **deployed** kora-api, so the page returns 404s until the kora PR is deployed. Deploy per the established sequence: wait for `build-image` on the main CI run, patch the ArgoCD `image.tag` parameter to the full SHA, then verify the **running pod's** image digest changed — `Synced/Healthy` alone has been misleading before.

Then: open `/admin/apps/kora/feedback`, confirm the default view shows open items, change one status and confirm it persists across a reload.

---

## Self-Review

**Spec coverage.** `GET /v1/admin/feedback` with status/kind/limit/offset and 400s on invalid filters → Task 2. Newest-first ordering, unpaginated `total`, users join → Task 1. `PATCH` status-only with `Status.Valid()`, 400/404 → Tasks 1–2. Client functions → Task 3. Page, default `status=open`, expandable description with device context, nav entry, rail-containment → Task 4. No migration anywhere. Replies/notifications/ticket numbers/bulk edits/mobile changes absent, as the spec requires.

**Placeholder scan.** Every code step carries real code. Three steps deliberately say "read the existing file and match it" (test harnesses, `koraAdmin`'s body option, the actions return convention) — these are instructions to match a convention I have verified exists, not deferred decisions, and each names the exact file to read.

**Type consistency.** `ListParams`/`Item`/`ListResult`/`ErrNotFound`/`DefaultLimit`/`MaxLimit` defined in Task 1, consumed in Task 2. `NewAdminHandler` produced in Task 2, wired in the same task. `KoraFeedback`/`KoraFeedbackPage`/`listKoraFeedback`/`updateKoraFeedbackStatus` defined in Task 3, consumed in Task 4. Status strings are the same four everywhere: `open`, `in_progress`, `resolved`, `closed`.
