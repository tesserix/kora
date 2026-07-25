# Weight Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kora's weight tracking real — a `weight_entries` time series with log/list endpoints, and a Progress screen that reads real data + lets you log weight.

**Architecture:** Backend adds weight to the existing `internal/tracking` package (peer of water): migration + model + repo + handlers + routes. Mobile adds two hooks and rewrites the Progress weight card to use them, plus a log-weight sheet. Four tasks: 2 backend, 2 mobile.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate; Expo SDK 57, React Query v5, @testing-library/react-native v14 (async `render`/`fireEvent`), TypeScript strict.

## Global Constraints

- Backend mirrors the existing water code in `api/internal/tracking` (model/repo/handler shapes, `httpx` helpers, `resolveUser`). `gofmt`/`go vet` clean.
- Go DB tests run FOREGROUND from `api/` with `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable` and `go test -race -p 1 -count=1`. Postgres is docker container `infra-postgres-1`. Migrations are reversible; do NOT add a shared-DB down-migration test (verify up/down manually).
- Mobile: no `any`, no `console.log`; `interface`/named `type` for prop shapes; immutability (derive, never mutate); every mutation error surfaces a visible message. Tests FOREGROUND: `npx tsc --noEmit` then `npm test -- --ci`.
- Weight is **kg only**. The `WeightChart` requires **≥2 points** (`x(i)=…/(points.length-1)` divides by zero on a single point) — render it only when `points.length >= 2`; otherwise show the current number + a hint, no chart.
- `apiFetch` returns `body.data ?? body`. Query keys: weight series = `["weight", range]`; invalidate `["weight"]`.
- Conventional single-line commits, no signature.

---

### Task 1: Backend — migration + WeightEntry model + repository

**Files:**
- Create: `api/internal/database/migrations/000008_weight_entries.up.sql`, `…/000008_weight_entries.down.sql`
- Modify: `api/internal/tracking/model.go` (add `WeightEntry`)
- Modify: `api/internal/tracking/repository.go` (add `AddWeight`, `WeightSeries`)
- Test: `api/internal/tracking/repository_test.go` (add weight tests; reuse `testDB`/`seedUser`)

**Interfaces:**
- Produces: `tracking.WeightEntry{ID, UserID, WeightKg float64, LoggedAt, CreatedAt}`; `Repository.AddWeight(ctx, userID uuid.UUID, weightKg float64, at time.Time) (WeightEntry, error)`; `Repository.WeightSeries(ctx, userID uuid.UUID, from, to time.Time) ([]WeightEntry, error)`.

- [ ] **Step 1: Write the migration files**

`api/internal/database/migrations/000008_weight_entries.up.sql`:
```sql
CREATE TABLE weight_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weight_kg DOUBLE PRECISION NOT NULL,
    logged_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_weight_entries_user_logged ON weight_entries (user_id, logged_at);
```
`api/internal/database/migrations/000008_weight_entries.down.sql`:
```sql
DROP TABLE IF EXISTS weight_entries;
```

- [ ] **Step 2: Apply the migration to the test DB**

Run: `cd api && DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable" go run ./cmd/migrate`
Expected: migrates to version 8 with no error. Verify: `docker exec infra-postgres-1 psql -U kora -d kora_test -c "\d weight_entries"` shows the table.

- [ ] **Step 3: Write the failing repo tests**

Append to `api/internal/tracking/repository_test.go` (reuse the file's `testDB` + `seedUser`; note `seedUser`'s cleanup deletes the user, which `ON DELETE CASCADE` removes weight rows for — no extra cleanup needed):
```go
func TestAddWeightHappyPathAndRejectsNonPositive(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	e, err := repo.AddWeight(context.Background(), userID, 72.4, time.Now())
	require.NoError(t, err)
	require.Equal(t, 72.4, e.WeightKg)
	require.NotEqual(t, uuid.Nil, e.ID)

	_, err = repo.AddWeight(context.Background(), userID, 0, time.Now())
	require.Error(t, err)
	_, err = repo.AddWeight(context.Background(), userID, -5, time.Now())
	require.Error(t, err)
}

func TestWeightSeriesInRangeAscendingAndUserScoped(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	other := seedUser(t, db)
	repo := NewRepository(db)

	d1 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 3, 3, 8, 0, 0, 0, time.UTC)
	outOfRange := time.Date(2026, 2, 1, 8, 0, 0, 0, time.UTC)
	_, _ = repo.AddWeight(context.Background(), userID, 73.0, d2) // insert out of order
	_, _ = repo.AddWeight(context.Background(), userID, 74.0, d1)
	_, _ = repo.AddWeight(context.Background(), userID, 99.0, outOfRange)
	_, _ = repo.AddWeight(context.Background(), other, 60.0, d1) // other user, must be excluded

	got, err := repo.WeightSeries(context.Background(), userID,
		time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, 74.0, got[0].WeightKg) // ascending by logged_at
	require.Equal(t, 73.0, got[1].WeightKg)
}
```

- [ ] **Step 4: Run tests — verify they fail**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable" go test -race -p 1 -count=1 ./internal/tracking/`
Expected: compile failure — `WeightEntry`/`AddWeight`/`WeightSeries` undefined.

- [ ] **Step 5: Add the model**

Append to `api/internal/tracking/model.go` (mirror `WaterEntry`; GORM pluralizes `WeightEntry` → `weight_entries`):
```go
type WeightEntry struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID    uuid.UUID `json:"-"`
	WeightKg  float64   `json:"weight_kg"`
	LoggedAt  time.Time `json:"logged_at"`
	CreatedAt time.Time `json:"created_at"`
}
```

- [ ] **Step 6: Add the repository methods**

Append to `api/internal/tracking/repository.go`:
```go
func (r Repository) AddWeight(ctx context.Context, userID uuid.UUID, weightKg float64, at time.Time) (WeightEntry, error) {
	if weightKg <= 0 {
		return WeightEntry{}, httpx.ValidationError{Message: "weight_kg must be positive"}
	}
	if at.IsZero() {
		at = time.Now()
	}
	e := WeightEntry{UserID: userID, WeightKg: weightKg, LoggedAt: at}
	if err := r.db.WithContext(ctx).Create(&e).Error; err != nil {
		return WeightEntry{}, fmt.Errorf("tracking: add weight: %w", err)
	}
	return e, nil
}

func (r Repository) WeightSeries(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]WeightEntry, error) {
	entries := []WeightEntry{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, from, to).
		Order("logged_at ASC").
		Find(&entries).Error
	if err != nil {
		return nil, fmt.Errorf("tracking: weight series: %w", err)
	}
	return entries, nil
}
```

- [ ] **Step 7: Run tests — verify they pass**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable" go test -race -p 1 -count=1 ./internal/tracking/`
Then: `gofmt -l internal/tracking && go vet ./internal/tracking/`
Expected: all tracking tests pass; gofmt/vet clean.

- [ ] **Step 8: Commit**

```bash
git add api/internal/database/migrations/000008_weight_entries.up.sql api/internal/database/migrations/000008_weight_entries.down.sql api/internal/tracking/model.go api/internal/tracking/repository.go api/internal/tracking/repository_test.go
git commit -m "feat(tracking): weight_entries table + AddWeight/WeightSeries repo"
```

---

### Task 2: Backend — weight handlers + routes

**Files:**
- Modify: `api/internal/tracking/handler.go` (add `AddWeight`, `ListWeight`)
- Modify: `api/internal/server/router.go` (mount `POST`/`GET /v1/weight`)
- Test: `api/internal/tracking/handler_test.go` (new — reuse `testDB`/`seedUser` from `repository_test.go`, same package)

**Interfaces:**
- Consumes: `Repository.AddWeight`/`WeightSeries` (Task 1); `user.IDFromContext`.
- Produces: `Handler.AddWeight`, `Handler.ListWeight` (methods on the existing `tracking.Handler`).

- [ ] **Step 1: Write the failing handler tests**

Create `api/internal/tracking/handler_test.go`:
```go
package tracking

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func weightRouter(userID uuid.UUID, repo Repository) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	h := NewHandler(repo)
	r.POST("/v1/weight", h.AddWeight)
	r.GET("/v1/weight", h.ListWeight)
	return r
}

func TestAddWeightHandler(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := weightRouter(userID, NewRepository(db))

	req := httptest.NewRequest(http.MethodPost, "/v1/weight", strings.NewReader(`{"weight_kg":72.4}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	// non-positive weight -> 400
	req = httptest.NewRequest(http.MethodPost, "/v1/weight", strings.NewReader(`{"weight_kg":0}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestListWeightHandlerReturnsSeries(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	r := weightRouter(userID, repo)

	base := time.Now().Add(-48 * time.Hour)
	_, _ = repo.AddWeight(context.Background(), userID, 74.0, base)
	_, _ = repo.AddWeight(context.Background(), userID, 73.5, base.Add(24*time.Hour))

	from := time.Now().Add(-72 * time.Hour).Format(time.RFC3339)
	to := time.Now().Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodGet, "/v1/weight?from="+from+"&to="+to, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data []WeightEntry `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data, 2)
	require.Equal(t, 74.0, body.Data[0].WeightKg)
}
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable" go test -race -p 1 -count=1 ./internal/tracking/ -run Weight`
Expected: compile failure — `h.AddWeight`/`h.ListWeight` undefined.

- [ ] **Step 3: Add the handlers**

Append to `api/internal/tracking/handler.go`:
```go
type addWeightRequest struct {
	WeightKg float64   `json:"weight_kg"`
	LoggedAt time.Time `json:"logged_at"`
}

func (h Handler) AddWeight(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req addWeightRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	e, err := h.repo.AddWeight(c.Request.Context(), userID, req.WeightKg, req.LoggedAt)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": e})
}

func (h Handler) ListWeight(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	to, err := time.Parse(time.RFC3339, c.Query("to"))
	if err != nil {
		to = time.Now()
	}
	from, err := time.Parse(time.RFC3339, c.Query("from"))
	if err != nil {
		from = to.AddDate(-1, 0, 0)
	}
	entries, err := h.repo.WeightSeries(c.Request.Context(), userID, from, to)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load weight series")
		return
	}
	httpx.OK(c, entries)
}
```
(`net/http`, `time`, `httpx`, `gin` are already imported in `handler.go`.)

- [ ] **Step 4: Mount the routes**

In `api/internal/server/router.go`, immediately after the two `/water` route lines (`v1.POST("/water", trackingHandler.Add)` / `v1.GET("/water", trackingHandler.DayTotal)`), add:
```go
		v1.POST("/weight", trackingHandler.AddWeight)
		v1.GET("/weight", trackingHandler.ListWeight)
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd api && TEST_DATABASE_URL="postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable" go test -race -p 1 -count=1 ./internal/tracking/ ./internal/server/`
Then: `gofmt -l internal/tracking internal/server && go vet ./internal/tracking/ ./internal/server/`
Expected: tracking + server tests pass; gofmt/vet clean.

- [ ] **Step 6: Commit**

```bash
git add api/internal/tracking/handler.go api/internal/tracking/handler_test.go api/internal/server/router.go
git commit -m "feat(tracking): POST/GET /v1/weight endpoints"
```

---

### Task 3: Mobile — Profile.weight_kg + hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (add `weight_kg` to `Profile`; add `WeightEntry`)
- Modify: `apps/mobile/src/api/hooks.ts` (add `useAddWeight`, `useWeightSeries`)
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx` (extend)

**Interfaces:**
- Produces: `useAddWeight()` (mutate `{ weight_kg: number; logged_at?: string }`); `useWeightSeries(range: "1W"|"1M"|"3M"|"1Y")` → `WeightEntry[]`; `WeightRange` type; `WeightEntry` type; `Profile.weight_kg: number`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/api/__tests__/hooks.test.tsx` (reuse the existing `@/lib/api` mock + `wrapper`):
```tsx
import { useAddWeight, useWeightSeries } from "../hooks";

test("useAddWeight POSTs /v1/weight and invalidates weight", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "w1" });
  const { result } = await renderHook(() => useAddWeight(), { wrapper });
  result.current.mutate({ weight_kg: 72.4 });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/weight", {
    method: "POST",
    body: JSON.stringify({ weight_kg: 72.4, logged_at: undefined }),
  });
});

test("useWeightSeries GETs /v1/weight with a ~30d from/to for 1M", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([]);
  const { result } = await renderHook(() => useWeightSeries("1M"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const url = (apiFetch as jest.Mock).mock.calls[0][0] as string;
  const params = new URLSearchParams(url.split("?")[1]);
  const from = new Date(params.get("from") as string).getTime();
  const to = new Date(params.get("to") as string).getTime();
  const days = (to - from) / (24 * 60 * 60 * 1000);
  expect(Math.round(days)).toBe(30);
});
```
Note: `JSON.stringify({ weight_kg: 72.4, logged_at: undefined })` serializes to `{"weight_kg":72.4}` — the assertion string must match what the hook produces, so the hook builds the body the same way (see Step 3).

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd apps/mobile && npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: FAIL — `useAddWeight`/`useWeightSeries` not exported.

- [ ] **Step 3: Add types + hooks**

In `apps/mobile/src/api/types.ts`, add `weight_kg: number;` to the `Profile` type (after `onboarded_at`), and add:
```ts
export type WeightEntry = {
  id: string;
  weight_kg: number;
  logged_at: string;
};
```

In `apps/mobile/src/api/hooks.ts`, add the `WeightEntry` import to the `./types` import block, then add:
```ts
export function useAddWeight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ weight_kg, logged_at }: { weight_kg: number; logged_at?: string }) =>
      apiFetch("/v1/weight", { method: "POST", body: JSON.stringify({ weight_kg, logged_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["weight"] }),
  });
}

const WEIGHT_RANGE_DAYS = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365 } as const;
export type WeightRange = keyof typeof WEIGHT_RANGE_DAYS;

export function useWeightSeries(range: WeightRange) {
  return useQuery({
    queryKey: ["weight", range],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - WEIGHT_RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
      return apiFetch(`/v1/weight?from=${from.toISOString()}&to=${to.toISOString()}`) as Promise<WeightEntry[]>;
    },
  });
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: tsc clean; the two new tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): add useAddWeight/useWeightSeries hooks + Profile.weight_kg"
```

---

### Task 4: Mobile — Progress real data + log-weight sheet

**Files:**
- Create: `apps/mobile/src/components/progress/WeightLogSheet.tsx`
- Modify: `apps/mobile/app/(tabs)/progress.tsx`
- Test: `apps/mobile/src/components/progress/__tests__/WeightLogSheet.test.tsx` (new), `apps/mobile/app/(tabs)/__tests__/progress.test.tsx` (new or extend)

**Interfaces:**
- Consumes: `useWeightSeries`, `useAddWeight`, `useProfile`, `useDashboard`; `WeightEntry`; `Sheet`, `Button`, `WeightChart`, `Numeral`, `Badge`.

- [ ] **Step 1: Write the failing WeightLogSheet test**

Create `apps/mobile/src/components/progress/__tests__/WeightLogSheet.test.tsx`:
```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { WeightLogSheet } from "../WeightLogSheet";

const mockAddMutate = jest.fn();
jest.mock("@/api/hooks", () => ({ useAddWeight: () => ({ mutate: mockAddMutate, isPending: false }) }));
beforeEach(() => mockAddMutate.mockClear());

test("Save parses the input and calls useAddWeight; rejects non-positive", async () => {
  const onClose = jest.fn();
  const { getByText, getByLabelText } = await render(
    <WeightLogSheet visible initialKg={72.4} onClose={onClose} />,
  );
  // clear + enter a bad value -> no mutate
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "0");
  await fireEvent.press(getByText("Save"));
  expect(mockAddMutate).not.toHaveBeenCalled();
  // valid value -> mutate with parsed number
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "71.8");
  await fireEvent.press(getByText("Save"));
  expect(mockAddMutate).toHaveBeenCalledWith(
    { weight_kg: 71.8 },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/progress/__tests__/WeightLogSheet.test.tsx`
Expected: FAIL — `../WeightLogSheet` not found.

- [ ] **Step 3: Implement WeightLogSheet**

Create `apps/mobile/src/components/progress/WeightLogSheet.tsx`:
```tsx
import { useState } from "react";
import { TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useAddWeight } from "@/api/hooks";
import { useTheme } from "@/theme";

interface WeightLogSheetProps {
  visible: boolean;
  initialKg: number;
  onClose: () => void;
}

export function WeightLogSheet({ visible, initialKg, onClose }: WeightLogSheetProps) {
  const { colors, fonts } = useTheme();
  const [text, setText] = useState(initialKg > 0 ? String(initialKg) : "");
  const [err, setErr] = useState<string | null>(null);
  const addWeight = useAddWeight();

  const onSave = () => {
    const kg = parseFloat(text);
    if (!Number.isFinite(kg) || kg <= 0) {
      setErr("Enter a weight in kg.");
      return;
    }
    setErr(null);
    addWeight.mutate(
      { weight_kg: kg },
      { onSuccess: () => onClose(), onError: () => setErr("Couldn't save. Try again.") },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Log weight</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 18 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            keyboardType="decimal-pad"
            placeholder="0.0"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Weight in kilograms"
            style={{ flex: 1, fontSize: 28, fontFamily: fonts.mono, color: colors.foreground, borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 8 }}
          />
          <AppText muted style={{ fontSize: 16, fontFamily: fonts.mono }}>kg</AppText>
        </View>
        {err ? <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{err}</AppText> : null}
        <Button title="Save" onPress={onSave} disabled={addWeight.isPending} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/progress/__tests__/WeightLogSheet.test.tsx`
Expected: tsc clean; PASS.

- [ ] **Step 5: Write the failing Progress test**

Create `apps/mobile/app/(tabs)/__tests__/progress.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";
import Progress from "../progress";

const seriesMock = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { streak_days: 3 } }),
  useProfile: () => ({ data: { weight_kg: 80 } }),
  useWeightSeries: () => seriesMock(),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
}));

test("shows real current weight when entries exist", async () => {
  seriesMock.mockReturnValue({ data: [
    { id: "1", weight_kg: 74.0, logged_at: "2026-07-20T08:00:00Z" },
    { id: "2", weight_kg: 71.9, logged_at: "2026-07-23T08:00:00Z" },
  ] });
  const { getByText } = await render(<Progress />);
  // 71.9 = latest entry; distinct from the old hardcoded "72.4" placeholder, so
  // this fails on the pre-rewrite screen (real RED) and passes on the new one.
  expect(getByText("71.9")).toBeTruthy();
});

test("seeds current weight from profile when the range is empty", async () => {
  seriesMock.mockReturnValue({ data: [] });
  const { getByText } = await render(<Progress />);
  expect(getByText("80.0")).toBeTruthy();            // profile.weight_kg seed
  expect(getByText(/Log your weight/i)).toBeTruthy(); // hint, no chart
});
```

- [ ] **Step 6: Run — verify it fails**

Run: `cd apps/mobile && npm test -- --ci "app/(tabs)/__tests__/progress.test.tsx"`
Expected: FAIL — current Progress renders the hardcoded `72.4` placeholder regardless and has no seed/hint; the empty-case `80.0` assertion fails.

- [ ] **Step 7: Rewrite Progress to use real data**

Replace `apps/mobile/app/(tabs)/progress.tsx` with:
```tsx
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Numeral } from "@/components/Numeral";
import { Badge } from "@/components/Badge";
import { Icon } from "@/components/Icon";
import { WeightChart } from "@/components/progress/WeightChart";
import { WeightLogSheet } from "@/components/progress/WeightLogSheet";
import { useDashboard, useProfile, useWeightSeries } from "@/api/hooks";
import type { WeightEntry } from "@/api/types";
import { useTheme } from "@/theme";

const RANGES = ["1W", "1M", "3M", "1Y"] as const;

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
const shortDate = (isoStr: string) => new Date(isoStr).toLocaleDateString([], { month: "short", day: "numeric" });

export default function Progress() {
  const { colors, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const [sheetOpen, setSheetOpen] = useState(false);
  const dashboard = useDashboard(today());
  const profile = useProfile();
  const series = useWeightSeries(range);
  const streak = dashboard.data?.streak_days ?? 0;

  const entries = (series.data ?? []) as WeightEntry[];
  const points = entries.map((e) => e.weight_kg);
  const hasChart = points.length >= 2;
  const current = entries.length ? entries[entries.length - 1].weight_kg : (profile.data?.weight_kg ?? 0);
  const delta = hasChart ? points[points.length - 1] - points[0] : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader
        overline="Trends"
        title="Progress"
        right={
          <Pressable accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Icon name="sparkles" size={15} color={colors.foreground} />
            <AppText style={{ fontSize: 13, fontWeight: "600" }}>Weekly report</AppText>
          </Pressable>
        }
      />

      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <Card style={{ padding: 18 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Log weight" onPress={() => setSheetOpen(true)}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <View>
                <AppText muted style={{ fontSize: 12, fontWeight: "600" }}>Weight</AppText>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                  <Numeral size={30}>{current > 0 ? current.toFixed(1) : "—"}</Numeral>
                  <AppText muted style={{ fontSize: 14 }}>kg</AppText>
                </View>
              </View>
              {delta !== null ? (
                <Badge variant="success" icon={delta <= 0 ? "trending-down" : "trending-up"}>{`${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`}</Badge>
              ) : null}
            </View>
          </Pressable>

          {hasChart ? (
            <>
              <WeightChart points={points} />
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                <AppText muted style={{ fontFamily: fonts.mono, fontSize: 9 }}>{shortDate(entries[0].logged_at)}</AppText>
                <AppText muted style={{ fontFamily: fonts.mono, fontSize: 9 }}>{shortDate(entries[entries.length - 1].logged_at)}</AppText>
              </View>
            </>
          ) : (
            <AppText muted style={{ fontSize: 13, paddingVertical: 16, textAlign: "center" }}>Log your weight to see a trend.</AppText>
          )}

          <View style={{ flexDirection: "row", gap: 6, marginTop: 14 }}>
            {RANGES.map((r) => {
              const on = range === r;
              return (
                <Pressable key={r} accessibilityRole="button" onPress={() => setRange(r)} style={{ flex: 1, paddingVertical: 7, borderRadius: radius.md, alignItems: "center", backgroundColor: on ? colors.secondary : "transparent" }}>
                  <AppText style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: "700", color: on ? colors.primary : colors.mutedForeground }}>{r}</AppText>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg intake" value="1,921" unit="kcal" delta="On target" trend="down" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Log streak" value={String(streak)} unit={streak === 1 ? "day" : "days"} delta="Keep it up" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg steps" value="8,240" delta="+6% wk" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg sleep" value="7.1" unit="hrs" /></Card>
        </View>
      </View>

      <WeightLogSheet visible={sheetOpen} initialKg={current} onClose={() => setSheetOpen(false)} />
    </ScrollView>
  );
}
```
(`Avg intake`/`Avg steps`/`Avg sleep` stay static — out of scope. The `Weekly report` button stays a no-op — out of scope.)

- [ ] **Step 8: Run tests — verify they pass, then the whole suite**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci "app/(tabs)/__tests__/progress.test.tsx" src/components/progress/__tests__/WeightLogSheet.test.tsx`
Then the whole suite: `npm test -- --ci`
Expected: tsc clean; the new tests pass; whole suite green.

- [ ] **Step 9: Commit**

```bash
git add "apps/mobile/app/(tabs)/progress.tsx" apps/mobile/src/components/progress/WeightLogSheet.tsx "apps/mobile/app/(tabs)/__tests__/progress.test.tsx" apps/mobile/src/components/progress/__tests__/WeightLogSheet.test.tsx
git commit -m "feat(mobile): real weight tracking on Progress + log-weight sheet"
```

---

## Verification (whole feature)

- Backend: `cd api && TEST_DATABASE_URL=…kora_test go test -race -p 1 -count=1 ./...` green; `gofmt`/`go vet` clean. Migration 000008 up + down verified against kora_test.
- Mobile: `npx tsc --noEmit` clean; `npm test -- --ci` all green.
- Live (optional, when the rig is stable): re-seed nothing (weight is new); sign in, open Progress → current weight shows the onboarding weight with the "Log your weight to see a trend" hint; tap the weight card → sheet → enter a value → Save → the number updates; log a second value → the chart appears; the 1W/1M/3M/1Y toggle refetches.
