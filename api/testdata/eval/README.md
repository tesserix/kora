# Kora resolution eval dataset

Golden dataset for the Phase 2 resolution engine. **User-provided** — the real
files here (except the committed `*.sample.*`) are gitignored.

## chat.jsonl (one JSON object per line)
{"phrase": "two eggs and toast", "expected_name": "Egg", "expected_kcal": 155, "grams": 100}
- `phrase`      — the text a user would type/speak.
- `expected_name` — substring expected in the top-1 resolved candidate's item name (case-insensitive).
- `expected_kcal`  — reference kcal for the stated `grams` (for the median-error metric).
- `grams`        — portion the reference kcal is stated for.

## photos/ + photos.jsonl
photos.jsonl: {"file": "photos/omelette.jpg", "expected_name": "Egg", "expected_kcal": 155, "grams": 100}
- `file` is relative to testdata/eval/.

## ranking.sample.jsonl (one JSON object per line) — provider-free

Committed, unlike the files above: this is the regression suite for index and
ranking changes, so it has to travel with the code. `ranking.jsonl` overrides it
if present (and stays gitignored).

    {"phrase": "Coke Zero", "guesses": [{"food": "coke zero", "portion_estimate": "1 can"}], "expected_name": "Coke Zero", "note": "..."}

- `phrase`   — the text a user would type/speak.
- `guesses`  — the guess strings identify is known to emit for that phrase
  (`food`, optional `portion_estimate`, `cooking_method`, `confidence`; confidence
  defaults to the 0.95 identify was measured emitting). The harness feeds these
  to `nutrition.Resolve` directly, so no AI provider is called and nothing is spent.
- `expected_name` — substring expected in the top-1 item name. Recorded ONLY where
  the right answer is genuinely known; **left empty where it is still a judgement
  call**, and it must stay that way. A case with no expected value still prints
  what happens — that is the point.
- `note`     — provenance of the case (which production failure, what it probes).

Run it:

    set -a && . ./.env && set +a
    KORA_EVAL=1 go test -tags eval ./internal/ai/ -run TestEvalRanking -v

Per guess it prints the top 10 candidates (name, provenance, kcal/100g,
`MatchScore`, `MatchTier`), the case's `nutrition.PhraseCoverage`, the reduction
factor it produces, and the tier before and after damping. Machine-readable TSV
goes to `KORA_EVAL_RANKING_OUT` (default `ranking.out.tsv` in this directory) —
two runs over an unchanged index produce a byte-identical file, so
`diff before.tsv after.tsv` is the measurement.

Read-only against the database: SELECTs only, and the TSV is the one file it
writes. It never calls a provider, so the embedding tier of `nutrition.Resolve`
is skipped (nil query vector) — a ranking change visible only through embeddings
is out of scope by design, which is the price of determinism.

The only assertion is that cases with a KNOWN `expected_name` still pass.
Everything else is diagnostic.

## au_phrases.txt + TestRecordGuesses — the AU accuracy set

`au_phrases.txt` is 50 ordinary Australian phrases, one per line, chosen to
cover the shapes that have actually broken rather than just common foods:
conjunctions the index spells `&` (kora#235), a stated cooking method against a
raw row (kora#467), colloquial abbreviations (kora#469), composite dishes
identify must split, and takeaway/brand-named items.

**The guesses are RECORDED from the live provider, never invented.** A case
whose guesses someone imagined measures a pipeline that does not exist. Record
them with:

    set -a && . ./.env && set +a
    KORA_EVAL=1 KORA_EVAL_RECORD=1 \
      go test -tags eval ./internal/ai/ -run TestRecordGuesses -v

That calls a provider, costs money and is nondeterministic, which is why it sits
behind its own `KORA_EVAL_RECORD` flag on top of `KORA_EVAL`. It goes through
`ai.Router` — the real production path, primary plus fallback — because a stub or
a bare provider records output the product never actually produces. Output is
ranking-dataset JSONL; it is NOT merged into `ranking.sample.jsonl` automatically,
because every case still needs a human to decide whether the right answer is
genuinely known.

### Read the HIT rate correctly — it is a REGRESSION PIN, not an accuracy score

This is the trap worth stating plainly. `expected_name` values are chosen by a
human LOOKING AT what the resolver currently returns. A 100% hit rate therefore
means **"nothing has changed since these were recorded"**, not "the resolver is
right". It is circular by construction, and that is fine — pinning behaviour is
exactly what a regression suite is for — but it must never be quoted as accuracy.

Measuring accuracy means judging the output against what the food ACTUALLY is,
independently of what the resolver said. Done by hand over these 50 phrases on
2026-08-26:

| | |
|---|---|
| phrases probed | 50 |
| resolves acceptably | **34 (68%)** |
| clearly wrong | 14 |
| reference value looks wrong | 2 |

The dominant single cause was the bare guess `toast`, which returns `French
toast, plain` and accounted for 3 of the 14 — "X on toast" being a staple
Australian breakfast.

**Re-do that judgement by hand when the number is claimed.** It cannot be
derived from the harness, and the harness will happily report 100% while the
resolver is 68% right.

## Thresholds (exit gate)
- chat top-1 id accuracy  >= 0.90
- photo top-1 id accuracy >= 0.80
- resolved-entry correctness (a confident candidate returned) >= 0.90
- median kcal error <= 0.20
- zero hallucinated rows (every candidate has a real food_items.id)
