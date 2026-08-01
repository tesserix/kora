# Food Index: Embeddings + Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the food index usable — ship the `embed` binary so embeddings can be generated in-cluster, and grow the index from 85 items to ~8,000 plus a curated Australian/Indian set.

**Architecture:** `cmd/embed` already exists and is correct; it is simply absent from the image and the seed Job. A new streaming converter turns USDA SR Legacy JSON into the existing ingest row shape, committed as a data file the image already ships. A hand-authored file covers AU/Indian dishes SR Legacy does not contain.

**Tech Stack:** Go 1.26 (`api/internal/nutrition/ingest`, `api/cmd/*`), Docker (alpine), Helm (`tesserix-k8s/charts/apps/kora-api`), Postgres + pgvector, Gemini `gemini-embedding-001` at 768 dims.

## Global Constraints

- **Two repos.** `kora` (Dockerfile, converter, data, ingest) and `tesserix-k8s` (seed Job). **The kora PR must merge and its image be published BEFORE the tesserix-k8s PR merges** — the Job exec-fails loudly against an image lacking `/usr/local/bin/embed`.
- Commit messages: conventional prefix, **single line**, no body, no signature trailers.
- Go tests need Postgres: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable` (Docker `kora-pg-test`, image `pgvector/pgvector:pg15`). Run from `api/`.
- **Run all test commands in the FOREGROUND.** Never background them.
- `Provenance` is a type **alias** (`type Provenance = string`), so `map[string]string` accepts the constants directly.
- The embedding vector is **768 dims** and must stay matched to the `vector(768)` column. Do not change either.
- Do not tune `tierAutoFloor` (0.90) or `tierConfirmFloor` (0.70). Out of scope.
- `cmd/srconvert` is a build-time tool and must **not** be added to the Dockerfile.

## Reference data (measured 2026-08-02, not assumed)

SR Legacy `FoodData_Central_sr_legacy_food_json_2021-10-28.zip` — 12.5 MB zip, 210 MB JSON, top-level `{"SRLegacyFoods":[...]}`.

- **7,793** records
- **7,793** have kcal (1008), protein (1003), carbs (1005), fat (1004) — so the skip path will report **0 skipped** on the real file. That is expected, not a bug.
- **7,231** have fibre (1079); the rest default to 0
- **7,533** have `foodPortions`; the rest fall back to 100 g
- Nutrient **1062 is Energy in kJ** — do not use it; 1008 is kcal
- Portion shape: `{"modifier": "cup", "gramWeight": 34.0, "sequenceNumber": 1}`

---

### Task 1: Ship the embed binary in the image

**Files:**
- Modify: `api/Dockerfile`

**Interfaces:**
- Produces: `/usr/local/bin/embed` in the published image. Task 5 (tesserix-k8s) depends on it existing.

- [ ] **Step 1: Add the build and copy lines**

In `api/Dockerfile`, after the existing `ingest` build line (currently line 16), add:

```dockerfile
# embed backfills food_items.embedding, the ONLY source of sub-0.70 match
# scores. Without it the resolver's embedding tier is dead: every item scores
# 0.70-0.99 via full-text, so `follow_up` is unreachable and per-item
# confidence tiers can never fire. Same omission as seed/ingest before #67.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/embed ./cmd/embed
```

And after the existing `ingest` copy line (currently line 26):

```dockerfile
COPY --from=build /bin/embed /usr/local/bin/embed
```

- [ ] **Step 2: Build the image and verify the artifact, not the Dockerfile**

Run, in the foreground, from the repo root:

```bash
docker build -t kora-api:embedcheck ./api
docker run --rm --entrypoint sh kora-api:embedcheck -c 'ls -1 /usr/local/bin'
```

Expected output contains all five: `api`, `embed`, `ingest`, `migrate`, `seed`.

If the build fails on an unrelated toolchain issue, report it rather than editing anything outside `api/Dockerfile`.

- [ ] **Step 3: Verify embed's no-key behaviour in the image**

```bash
docker run --rm -e DATABASE_URL=postgres://x/y kora-api:embedcheck embed
```

Expected: logs `cmd/embed: GEMINI_API_KEY required to generate embeddings; skipping` and exits **0**. This is the property that makes adding it to the Job safe — a missing secret degrades to "no embeddings", not a crashloop.

- [ ] **Step 4: Commit**

```bash
git add api/Dockerfile
git commit -m "feat(api): ship the embed binary so embeddings can be generated in-cluster"
```

---

### Task 2: SR Legacy converter

**Files:**
- Create: `api/internal/nutrition/ingest/srlegacy.go`
- Create: `api/internal/nutrition/ingest/testdata/sr_legacy_sample.json`
- Create: `api/internal/nutrition/ingest/srlegacy_test.go`
- Create: `api/cmd/srconvert/main.go`

**Interfaces:**
- Consumes: the unexported `row` struct in `api/internal/nutrition/ingest/loaders.go` (same package — reuse it, do not redeclare).
- Produces:
  - `type SRLegacyStats struct { Converted int; Skipped int }`
  - `func ConvertSRLegacy(r io.Reader, w io.Writer) (SRLegacyStats, error)`
  - Task 3 runs `cmd/srconvert` to generate the data file.

- [ ] **Step 1: Write the fixture**

Create `api/internal/nutrition/ingest/testdata/sr_legacy_sample.json` — three records: one complete with a portion, one complete without portions, one missing energy.

```json
{"SRLegacyFoods":[
{"foodClass":"FinalFood","description":"Cheese, cheddar","foodNutrients":[{"nutrient":{"id":1008},"amount":403.0},{"nutrient":{"id":1003},"amount":22.9},{"nutrient":{"id":1005},"amount":3.09},{"nutrient":{"id":1004},"amount":33.1},{"nutrient":{"id":1079},"amount":0.0},{"nutrient":{"id":1062},"amount":1687.0}],"foodPortions":[{"modifier":"cup, diced","gramWeight":132.0,"sequenceNumber":1}]},
{"foodClass":"FinalFood","description":"Spices, oregano, dried","foodNutrients":[{"nutrient":{"id":1008},"amount":265.0},{"nutrient":{"id":1003},"amount":9.0},{"nutrient":{"id":1005},"amount":68.9},{"nutrient":{"id":1004},"amount":4.28}]},
{"foodClass":"FinalFood","description":"Broken record, no energy","foodNutrients":[{"nutrient":{"id":1003},"amount":1.0},{"nutrient":{"id":1005},"amount":2.0},{"nutrient":{"id":1004},"amount":3.0}]}
]}
```

- [ ] **Step 2: Write the failing test**

Create `api/internal/nutrition/ingest/srlegacy_test.go`:

```go
package ingest

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConvertSRLegacy(t *testing.T) {
	in, err := os.Open("testdata/sr_legacy_sample.json")
	require.NoError(t, err)
	defer in.Close()

	var out bytes.Buffer
	stats, err := ConvertSRLegacy(in, &out)
	require.NoError(t, err)

	// The third record has no energy (1008) and must be dropped rather than
	// emitted as a zero-calorie row, which would later read as a measurement.
	require.Equal(t, 2, stats.Converted)
	require.Equal(t, 1, stats.Skipped)

	var rows []row
	require.NoError(t, json.Unmarshal(out.Bytes(), &rows))
	require.Len(t, rows, 2)

	// Names go in verbatim — no shortening. Shortening would collapse distinct
	// cuts into one row via the name+brand dedup and silently lose coverage.
	require.Equal(t, "Cheese, cheddar", rows[0].Name)
	require.Equal(t, 403.0, rows[0].KcalPer100g)
	require.Equal(t, 22.9, rows[0].ProteinPer100g)
	require.Equal(t, 3.09, rows[0].CarbsPer100g)
	require.Equal(t, 33.1, rows[0].FatPer100g)
	// The first portion supplies the serving; 1062 (kJ) must never be used.
	require.Equal(t, 132.0, rows[0].ServingGrams)
	require.Equal(t, "cup, diced (132 g)", rows[0].ServingDesc)

	// No portions -> fall back to 100 g rather than 0, which would make a
	// portion-scaled log silently zero.
	require.Equal(t, "Spices, oregano, dried", rows[1].Name)
	require.Equal(t, 100.0, rows[1].ServingGrams)
	require.Equal(t, "100 g", rows[1].ServingDesc)
	// Fibre is absent on this record and defaults to 0.
	require.Equal(t, 0.0, rows[1].FiberPer100g)
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd api && go test ./internal/nutrition/ingest/ -run TestConvertSRLegacy -v`

Expected: FAIL — `undefined: ConvertSRLegacy`. That is a build failure and therefore weak evidence; after Step 4 exists but before the mapping is right you should see real assertion failures. Report the assertion text, not just the build error.

- [ ] **Step 4: Write the converter**

Create `api/internal/nutrition/ingest/srlegacy.go`:

```go
package ingest

import (
	"encoding/json"
	"fmt"
	"io"
)

// USDA FoodData Central nutrient IDs. 1062 is Energy in kJ and is deliberately
// absent: using it would inflate every kcal figure by ~4.184x.
const (
	srNutrientKcal    = 1008
	srNutrientProtein = 1003
	srNutrientCarbs   = 1005
	srNutrientFat     = 1004
	srNutrientFiber   = 1079
)

// SRLegacyStats reports what a conversion did. Skipped counts records dropped
// for missing a required nutrient.
type SRLegacyStats struct {
	Converted int
	Skipped   int
}

type srFood struct {
	Description   string `json:"description"`
	FoodNutrients []struct {
		Nutrient struct {
			ID int `json:"id"`
		} `json:"nutrient"`
		Amount float64 `json:"amount"`
	} `json:"foodNutrients"`
	FoodPortions []struct {
		Modifier   string  `json:"modifier"`
		GramWeight float64 `json:"gramWeight"`
	} `json:"foodPortions"`
}

// ConvertSRLegacy streams USDA SR Legacy JSON and writes a JSON array of ingest
// rows. It streams record-by-record because the real file is 210 MB — decoding
// it whole would need over a gigabyte of heap for a build-time tool.
func ConvertSRLegacy(r io.Reader, w io.Writer) (SRLegacyStats, error) {
	var stats SRLegacyStats
	dec := json.NewDecoder(r)

	// Walk into {"SRLegacyFoods":[ ... ]} by token so the array elements can be
	// decoded one at a time.
	if _, err := dec.Token(); err != nil { // '{'
		return stats, fmt.Errorf("srlegacy: open object: %w", err)
	}
	if _, err := dec.Token(); err != nil { // "SRLegacyFoods"
		return stats, fmt.Errorf("srlegacy: key: %w", err)
	}
	if _, err := dec.Token(); err != nil { // '['
		return stats, fmt.Errorf("srlegacy: open array: %w", err)
	}

	rows := make([]row, 0, 8000)
	for dec.More() {
		var f srFood
		if err := dec.Decode(&f); err != nil {
			return stats, fmt.Errorf("srlegacy: decode record: %w", err)
		}

		amounts := make(map[int]float64, len(f.FoodNutrients))
		for _, n := range f.FoodNutrients {
			amounts[n.Nutrient.ID] = n.Amount
		}

		kcal, okKcal := amounts[srNutrientKcal]
		protein, okProtein := amounts[srNutrientProtein]
		carbs, okCarbs := amounts[srNutrientCarbs]
		fat, okFat := amounts[srNutrientFat]
		if f.Description == "" || !okKcal || !okProtein || !okCarbs || !okFat || kcal <= 0 {
			stats.Skipped++
			continue
		}

		servingGrams, servingDesc := 100.0, "100 g"
		for _, p := range f.FoodPortions {
			if p.GramWeight <= 0 {
				continue
			}
			servingGrams = p.GramWeight
			if p.Modifier != "" {
				servingDesc = fmt.Sprintf("%s (%.0f g)", p.Modifier, p.GramWeight)
			} else {
				servingDesc = fmt.Sprintf("%.0f g", p.GramWeight)
			}
			break
		}

		rows = append(rows, row{
			Name:           f.Description,
			ServingDesc:    servingDesc,
			ServingGrams:   servingGrams,
			KcalPer100g:    kcal,
			ProteinPer100g: protein,
			CarbsPer100g:   carbs,
			FatPer100g:     fat,
			FiberPer100g:   amounts[srNutrientFiber], // absent -> 0
		})
		stats.Converted++
	}

	enc := json.NewEncoder(w)
	enc.SetIndent("", "")
	if err := enc.Encode(rows); err != nil {
		return stats, fmt.Errorf("srlegacy: encode: %w", err)
	}
	return stats, nil
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd api && go test ./internal/nutrition/ingest/ -run TestConvertSRLegacy -v`

Expected: PASS.

- [ ] **Step 6: Mutation-check the kJ trap**

Temporarily change `srNutrientKcal` from `1008` to `1062` and re-run. The test MUST fail on `rows[0].KcalPer100g` (expecting 403, getting 1687). Restore `1008`. If it passes either way, the test is not pinning the unit and must be fixed.

- [ ] **Step 7: Add the command**

Create `api/cmd/srconvert/main.go`:

```go
// Command srconvert turns a USDA SR Legacy JSON export into the ingest row
// format. It is a BUILD-TIME tool: its output is committed to data/food and the
// binary is deliberately NOT shipped in the image.
package main

import (
	"flag"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/nutrition/ingest"
)

func main() {
	in := flag.String("in", "", "path to FoodData_Central_sr_legacy_food_json_*.json")
	out := flag.String("out", "data/food/usda_sr_legacy.json", "output path")
	flag.Parse()

	if *in == "" {
		log.Fatal("srconvert: -in required")
	}
	f, err := os.Open(*in)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	w, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	defer w.Close()

	stats, err := ingest.ConvertSRLegacy(f, w)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("srconvert: converted %d, skipped %d -> %s", stats.Converted, stats.Skipped, *out)
}
```

- [ ] **Step 8: Run the package tests and commit**

Run: `cd api && go test ./internal/nutrition/...`
Expected: `ok`.

```bash
git add api/internal/nutrition/ingest/srlegacy.go api/internal/nutrition/ingest/srlegacy_test.go api/internal/nutrition/ingest/testdata/sr_legacy_sample.json api/cmd/srconvert/main.go
git commit -m "feat(api): convert USDA SR Legacy exports into the ingest row format"
```

---

### Task 3: Generate the data file and ingest it

**Files:**
- Create: `api/data/food/usda_sr_legacy.json` (generated, ~1.5 MB)
- Modify: `api/cmd/ingest/main.go`

**Interfaces:**
- Consumes: `ConvertSRLegacy` / `cmd/srconvert` from Task 2.
- Produces: an `-sr` flag on `cmd/ingest`. Task 5's Job command passes it.

- [ ] **Step 1: Download and convert**

Run in the foreground (the download is ~12.5 MB, the unzipped file ~210 MB — put it in a scratch dir, NOT the repo):

```bash
mkdir -p /tmp/usda && cd /tmp/usda
curl -sL -o sr.zip "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2021-10-28.zip"
unzip -o -q sr.zip
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/api
go run ./cmd/srconvert -in /tmp/usda/FoodData_Central_sr_legacy_food_json_2021-10-28.json -out data/food/usda_sr_legacy.json
```

Expected: `srconvert: converted 7793, skipped 0 -> data/food/usda_sr_legacy.json`

**A skipped count of 0 is correct** — every record in the real file has kcal, protein, carbs and fat. Do not treat it as the skip path being broken; Task 2's fixture test is what proves that path works.

- [ ] **Step 2: Sanity-check the output**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/api
python3 -c "
import json
d=json.load(open('data/food/usda_sr_legacy.json'))
print('rows', len(d))
print('no kcal<=0:', all(r['kcal_per_100g']>0 for r in d))
print('sample:', d[0]['name'], d[0]['serving_desc'], d[0]['kcal_per_100g'])
"
ls -lh data/food/usda_sr_legacy.json
```

Expected: ~7793 rows, `no kcal<=0: True`, file around 1–2 MB.

- [ ] **Step 3: Write the failing test**

Add to `api/internal/nutrition/ingest/loaders_test.go`:

```go
// The generated SR Legacy file is committed data the image ships; if it is
// missing or malformed the prod food index silently loses ~7,800 items.
func TestLoadFileParsesGeneratedSRLegacy(t *testing.T) {
	items, err := LoadFile("../../../data/food/usda_sr_legacy.json", nutrition.ProvenanceUSDA)
	require.NoError(t, err)
	require.Greater(t, len(items), 7000)
	for _, it := range items[:50] {
		require.NotEmpty(t, it.Name)
		require.Greater(t, it.KcalPer100g, 0.0)
		require.Equal(t, nutrition.ProvenanceUSDA, it.Provenance)
	}
}
```

- [ ] **Step 4: Run it**

Run: `cd api && go test ./internal/nutrition/ingest/ -run TestLoadFileParsesGeneratedSRLegacy -v`
Expected: PASS (the file exists from Step 1). If it fails with "no such file", Step 1 did not write where you think — fix that, not the test.

- [ ] **Step 5: Add the ingest flag**

In `api/cmd/ingest/main.go`, add the flag beside the existing two:

```go
	sr := flag.String("sr", "data/food/usda_sr_legacy.json", "USDA SR Legacy JSON path (generated by cmd/srconvert)")
```

and add it to the map passed to `ingest.Run`:

```go
	n, err := ingest.Run(ctx, repo, map[string]string{
		*afcd: nutrition.ProvenanceAFCD,
		*usda: nutrition.ProvenanceUSDA,
		*sr:   nutrition.ProvenanceUSDA,
	})
```

- [ ] **Step 6: Build and commit**

Run: `cd api && go build ./... && go test ./internal/nutrition/...`
Expected: builds clean, tests `ok`.

```bash
git add api/data/food/usda_sr_legacy.json api/cmd/ingest/main.go api/internal/nutrition/ingest/loaders_test.go
git commit -m "feat(api): ingest the USDA SR Legacy food set"
```

---

### Task 4: Curated Australian and Indian dishes

**Files:**
- Create: `api/data/food/au_in_dishes.json`
- Modify: `api/internal/nutrition/model.go`
- Modify: `api/internal/database/migrations/000002_phase1_core.up.sql` (comment only)
- Modify: `api/cmd/ingest/main.go`
- Test: `api/internal/nutrition/ingest/loaders_test.go`

**Interfaces:**
- Consumes: the `-sr` flag pattern from Task 3.
- Produces: `nutrition.ProvenanceCurated` and a `-curated` ingest flag.

- [ ] **Step 1: Add the provenance constant**

In `api/internal/nutrition/model.go`, beside the existing constants:

```go
	// ProvenanceCurated marks hand-authored entries — dishes no public dataset
	// covers (USDA SR Legacy returns zero hits for dal, dosa, paneer, idli,
	// samosa, vegemite, weet-bix, lamington). Values are considered estimates
	// for a home-cooked portion, not lab measurements.
	ProvenanceCurated Provenance = "curated"
```

`provenance` is a free-text column with no CHECK constraint, so no migration is needed. Update the comment in `api/internal/database/migrations/000002_phase1_core.up.sql` line 19 to list it:

```sql
    provenance TEXT NOT NULL,               -- afcd | off | usda | label_ocr | user_estimate | curated
```

- [ ] **Step 2: Write the data file**

Create `api/data/food/au_in_dishes.json`. Use the exact row shape (`name`, `serving_desc`, `serving_grams`, `kcal_per_100g`, `protein_per_100g`, `carbs_per_100g`, `fat_per_100g`, `fiber_per_100g`). Cover at minimum these, and add more of the same kind:

Indian: Dal tadka; Dal makhani; Chana masala; Rajma; Chapati; Roti, wholemeal; Paratha, plain; Naan, plain; Plain dosa; Masala dosa; Idli, steamed; Medu vada; Sambar; Coconut chutney; Vegetable biryani; Chicken biryani; Butter chicken; Palak paneer; Paneer tikka; Chicken tikka masala; Aloo gobi; Baingan bharta; Poha; Upma; Samosa, fried; Pav bhaji; Curd, plain; Ghee; Raita, cucumber; Gulab jamun; Masala chai, with milk and sugar.

Australian: extend in the spirit of the existing `cmd/seed` table (which already has Vegemite, Weet-Bix, meat pie, sausage roll, flat white) with items it lacks, e.g. Lamington; Anzac biscuit; Tim Tam; Barramundi, grilled; Kangaroo fillet, grilled; Chiko roll; Fairy bread; Damper.

Every entry: per-100g figures from published composition data, rounded sensibly. `serving_grams` should be a realistic single serve (a chapati ~40 g, a dosa ~80 g, a samosa ~50 g). Do not invent precision — one decimal place at most on macros.

- [ ] **Step 3: Write the failing test**

Add to `api/internal/nutrition/ingest/loaders_test.go`:

```go
// The curated set exists because SR Legacy has zero coverage of these foods.
// If it stops loading, Australian and Indian users lose their entire index.
func TestLoadFileParsesCuratedDishes(t *testing.T) {
	items, err := LoadFile("../../../data/food/au_in_dishes.json", nutrition.ProvenanceCurated)
	require.NoError(t, err)
	require.Greater(t, len(items), 30)

	byName := map[string]nutrition.FoodItem{}
	for _, it := range items {
		require.Equal(t, nutrition.ProvenanceCurated, it.Provenance)
		require.Greater(t, it.KcalPer100g, 0.0)
		require.Greater(t, it.ServingGrams, 0.0)
		byName[it.Name] = it
	}
	for _, want := range []string{"Dal tadka", "Plain dosa", "Idli, steamed", "Butter chicken"} {
		_, ok := byName[want]
		require.True(t, ok, "curated set must contain %q", want)
	}
}
```

- [ ] **Step 4: Run it**

Run: `cd api && go test ./internal/nutrition/ingest/ -run TestLoadFileParsesCuratedDishes -v`
Expected: PASS. If a required name is missing, add it to the data file rather than weakening the test.

- [ ] **Step 5: Add the ingest flag**

In `api/cmd/ingest/main.go`:

```go
	curated := flag.String("curated", "data/food/au_in_dishes.json", "curated AU/Indian dishes JSON path")
```

and in the map:

```go
		*curated: nutrition.ProvenanceCurated,
```

- [ ] **Step 6: Full suite and commit**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./...`
Expected: all `ok`.

```bash
git add api/data/food/au_in_dishes.json api/internal/nutrition/model.go api/internal/database/migrations/000002_phase1_core.up.sql api/cmd/ingest/main.go api/internal/nutrition/ingest/loaders_test.go
git commit -m "feat(api): add a curated Australian and Indian dish set"
```

---

### Task 5: Run embed in the seed Job (tesserix-k8s)

**Files:**
- Modify: `tesserix-k8s/charts/apps/kora-api/values.yaml` (the `seed.command` block)
- Modify: `tesserix-k8s/charts/apps/kora-api/templates/seed-job.yaml` (env)

**Interfaces:**
- Consumes: `/usr/local/bin/embed` from Task 1, and the new data files from Tasks 3–4.

**DO NOT MERGE THIS BEFORE THE KORA IMAGE SHIPS `embed`.** The Job exec-fails loudly against an older image — which is the chart's deliberate convention, but it means merging out of order breaks prod syncs.

- [ ] **Step 1: Extend the command**

In `values.yaml`, replace the `seed.command` list so it also runs the new files and then embeds:

```yaml
seed:
  enabled: true
  command:
    - /bin/sh
    - -c
    - >-
      /usr/local/bin/seed &&
      /usr/local/bin/ingest
      -afcd /usr/local/share/kora/food/afcd_staples.json
      -usda /usr/local/share/kora/food/usda_common.json
      -sr /usr/local/share/kora/food/usda_sr_legacy.json
      -curated /usr/local/share/kora/food/au_in_dishes.json &&
      /usr/local/bin/embed
```

- [ ] **Step 2: Give the Job the Gemini key**

In `templates/seed-job.yaml`, in the container's `env:` list beside the existing `DATABASE_URL` entry, add:

```yaml
            # embed needs GEMINI_API_KEY to generate vectors. Without it
            # cmd/embed logs and exits 0, so a missing secret degrades to "no
            # embeddings" rather than a crashlooping Job.
            - name: GEMINI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ $secretName }}
                  key: {{ index .Values.secretEnv "GEMINI_API_KEY" }}
```

`secretEnv.GEMINI_API_KEY` already exists in `values.yaml` (mapped to `gemini_api_key`); only the Job never referenced it.

- [ ] **Step 3: Verify the rendered manifest, not the template**

Run in the foreground from `tesserix-k8s`:

```bash
helm template kora-api charts/apps/kora-api -f charts/apps/kora-api/values-prod.yaml 2>/dev/null | \
  awk '/kind: Job/,/^---/' | grep -nE "embed|GEMINI_API_KEY|gemini_api_key|usda_sr_legacy|au_in_dishes"
```

Expected: the command line contains `/usr/local/bin/embed`, both new `-sr`/`-curated` paths, and an env entry wiring `GEMINI_API_KEY` to key `gemini_api_key`.

If `values-prod.yaml` does not exist under that path, list the chart directory and use the correct prod values file rather than guessing.

- [ ] **Step 4: Commit**

```bash
git add charts/apps/kora-api/values.yaml charts/apps/kora-api/templates/seed-job.yaml
git commit -m "feat(kora-api): run embed in the seed job and give it the gemini key"
```

---

### Task 6: Verify in prod and in the app

This is the acceptance test. Tests do not catch what matters here: every high-value defect in this repo across five sessions was found by running the real thing — a 401 dead-end, an Undo button under its own sheet, an empty food index, an onboarding trap, and a tier system that was correct but inert.

**Files:** none.

- [ ] **Step 1: Confirm the Job ran embed**

After both PRs merge and ArgoCD syncs, check the seed Job's logs for `cmd/embed: embedded N food items` with N > 0. The first run is ~8,000 sequential API calls — expect 15–25 minutes. `backoffLimit: 5`, no deadline, so a slow run is not killed.

- [ ] **Step 2: Confirm embeddings exist**

Query prod for `select count(*) from food_items where embedding is not null`. Expected: non-zero, and rising toward the row count. Before this change it was **0**.

- [ ] **Step 3: Re-run the probe that failed on 2026-08-01**

Mint a token and resolve "chicken breast and lasagne" against prod. Before this change the lasagne was silently dropped — `resolveGuesses` skips a guess whose match set is empty. Expect a lasagne candidate now.

- [ ] **Step 4: Confirm the embedding tier actually fires**

Resolve a few phrases and inspect `match_tier` and `match_score` per candidate. Expect at least one `embedding` tier with a score **below 0.70**. This is the real acceptance criterion: sub-0.70 scores are the only thing that makes `follow_up` reachable, which is what turns #21's per-item tiers from inert into a feature a user can encounter.

- [ ] **Step 5: Log an Indian dish through the app**

On the simulator against prod, capture "dal and rice" (or similar) and confirm it resolves to curated entries and logs. Dismiss any LogBox toast before tapping near the footer. Screenshot with `xcrun simctl io <UDID> screenshot`, downscale with `sips -Z 900`.

- [ ] **Step 6: Report honestly**

State what was verified and what was not. If the embedding tier still never produces a sub-0.70 score, say so plainly — it would mean the tier thresholds need revisiting against real score distributions, which this plan deliberately left out of scope.
