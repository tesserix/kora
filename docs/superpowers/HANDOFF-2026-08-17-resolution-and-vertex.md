# Handoff — 2026-08-17: food resolution architecture + the Vertex egress blocker

Paste the section below into a fresh session. Everything here was measured today, not assumed.

---

> ## STATUS UPDATE — later on 2026-08-17. Read this before the body.
>
> Two sections below are now WRONG. They are left in place because the reasoning
> that produced them is instructive, but do not act on them.
>
> **1. The Vertex blocker is SOLVED** (kora#209, tesserix-k8s #378 + #379).
> It was never the PSC endpoint. `aiplatform.googleapis.com` resolves to
> `10.255.0.2`, and `allow-<ns>-egress` permitted only
> `0.0.0.0/0 except 10.0.0.0/8` on 443 — which excludes it. Calico dropped
> ztunnel's upstream dial.
>
> **"The PSC endpoint rejects pod-sourced TLS" was the second wrong diagnosis and
> is now disproved.** So is the framing of this as a kora-vs-devai difference:
> `devai-mcp-hub` fails identically. devai-api worked because of a *third*,
> pod-scoped NetworkPolicy that the namespace-level diff never compared.
>
> Why it fooled everyone: in ambient mesh `nc -z 10.255.0.2 443` **always
> succeeds** — it reaches ztunnel's local redirect socket, not the endpoint. The
> tell is ztunnel's own access log, `bytes_sent=0 bytes_recv=0
> duration="10001ms"` — nothing ever left the node.
>
> **2. Workstream 1, item 1 (IFCT) is DONE** (kora#215). 523 rows, all typed
> `generic` with no change to the #213 derivation, no tier regression.
>
> Item 2 (colloquial names) is also partly re-measured: `chana`, `curd`, `rajma`,
> `poha`, `bhindi` are **not** zero-match — the curated dish set already answers
> them. Only `moong dal` and `toor dal` return nothing. IFCT ships translations in
> its `lang` column (430/542 rows), but `toor` is absent from IFCT entirely and
> `curd`/`dahi` are absent as foods — a data gap, not an alias gap.
>
> Corrected details live on kora#209 and kora#212, and in the PR bodies for
> kora#215 / tesserix-k8s #378.

---

## Context

You are taking over Kora work mid-thread. Two live workstreams:

1. **Food resolution quality** (kora#184 → architecture in kora#212) — why the resolver returns wrong foods, and the phased fix.
2. **A prod egress blocker** (kora#209) — the `kora` namespace cannot reach Vertex AI; `devai` can. **Unsolved. Two wrong diagnoses already made — do not guess a third.**

## HARD RULES — violating these costs hours

- **Never run a bare `go test ./...` in `api/`.** `internal/nutrition`'s tests **truncate the shared dev `food_items` table** (kora#151). That destroyed the 15k-row dev index today and required a full rebuild. Run targeted packages only.
- **Prod data is on `kora-postgres-1` in the `kora` namespace**, NOT `global-postgres-1`. `global-postgres` still answers, has the right schema, and is a **stale copy** — reading it produced a confidently wrong conclusion today. Verify which instance a workload's `DATABASE_URL` points at before drawing conclusions.
- **Do NOT delete the `vertex-aiplatform` DNS zone.** A previous session recommended it based on a premise since disproved (see below).
- **Do NOT merge `feat/184-brand-aware-ranking`.** Parked deliberately; reasoning recorded on kora#212.
- Rebuilding the dev index: `cd api && set -a && . ./.env && set +a && go run ./cmd/ingest` (NOT `cmd/seed`, which only maintains a 61-row curated set).

## Workstream 1 — food resolution

**Merged today:** kora#210 (confidence damping when identify discards the phrase), #211 (ranking harness), #213 (`entity_type` data model), plus #204–#208.

**The measuring instrument — use it before and after every change:**
```
cd api && set -a && . ./.env && set +a
KORA_EVAL=1 KORA_EVAL_RANKING_OUT=/tmp/after.tsv go test -tags eval ./internal/ai/ -run TestEvalRanking
```
Provider-free, deterministic, byte-stable across runs. Diff before/after. **Known limitation:** it false-positives after any DB migration that rewrites rows, because `Resolve`'s full-text `ORDER BY similarity(...) DESC LIMIT` has no tiebreaker and Postgres heap order decides ties. Adding a deterministic tiebreaker deserves its own ticket.

**The core defect (kora#212):** the resolver infers meaning from string similarity over a `name` column, in a corpus mixing generic reference data, branded retail products and dishes. Phase 1 (`entity_type`) is merged. Phases 2–6 are specified on the issue.

**Open, in priority order for an India + Australia user base:**
1. **Ingest IFCT** (528 Indian generic foods) — licence cleared: `github.com/ifct2017/compositions` **at tag `2.0.5`, which is MIT** (HEAD is AGPL-3.0). **`enerc` is KILOJOULES** — importing as kcal overstates by 4.184×. Values carry `±SD` notation (`61.78±0.85`) that breaks naive float parsing.
2. **A colloquial-name layer.** IFCT is unreachable without it: `chana`, `moong`, `toor`, `curd` return **zero** matches because IFCT calls them Bengal gram, Green gram, Red gram. Aliases are legitimate here — this is *translation* (recorded fact), not the ranking heuristic rejected on #212.
3. **Locale weighting.** USDA is 7,764 rows — 51% of the index — serving almost none of your users. AFCD (AU) and IFCT (IN) should be primary; USDA fallback. **Locale must boost, not filter** — an AU-based user eating Indian food is the normal case.
4. **Extract embedded brands at ingest.** 150 USDA rows are US chain items with the brand in the NAME and an empty `brand` column (`McDONALD'S, FILET-O-FISH`), so they type as `generic` and brand-matching is blind to them. Decision made: **keep these rows**, don't exclude.
5. **Indian packaged foods** — accepted source, CC0: `kaggle.com/datasets/lalit7881/indian-packaged-foods-nutritional-dataset-2026`, 852 products. **Trap: `Calories_kcal` is per that row's `Serving_Size_g`, usually but NOT always 100** — normalise `×100÷serving`, or 20g-serving rows land 5× understated.
6. **INDB** (1,014 cooked Indian dishes, retention factors applied) — highest-value remaining piece, blocked on a licence email the user is sending.

**Source vetting standard — apply to any new dataset:** Atwater reconciliation, `calories ≈ 4·carbs + 4·protein + 9·fat` per row. Real label data reconciles tightly (the accepted set: 92% within 15%, **median deviation 0.4%**); fabricated data does not. Six datasets evaluated today, five rejected — including one synthetic set with 747-kcal beverages. **A synthetic dataset is more dangerous than a missing one**: a gap surfaces as "couldn't identify", fabricated values surface as a confident 998 kcal.

## Workstream 2 — the Vertex blocker (UNSOLVED)

**Symptom:** `aiplatform.googleapis.com` resolves to `10.255.0.2` (PSC endpoint `vertexapis`, via private DNS zone `vertex-aiplatform`). From `kora` pods, TLS resets. From `devai` pods, **TLS succeeds (TLSv1.3)**.

**Reproduce:**
```
CTX=gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke
kubectl --context $CTX -n devai exec devai-api-<pod> -- python3 -c "
import socket,ssl
s=socket.create_connection(('aiplatform.googleapis.com',443),timeout=8)
print(ssl.create_default_context().wrap_socket(s,server_hostname='aiplatform.googleapis.com').version())"   # works
```
Same probe from a `kora` pod → `ConnectionResetError`. Also fails from **kora-api's own meshed Deployment pod**, so it is not the seed Job's `sidecar.istio.io/inject: "false"` annotation.

**Eliminated by measurement — do not re-check these:**
- NetworkPolicy: full JSON diff of `allow-kora-egress` vs `allow-devai-egress` — only namespace allow-list differences. Both carry identical `0.0.0.0/0 except 10.0.0.0/8` on 443. devai's 4th policy only permits the `observability` namespace.
- Ambient/mesh: both namespaces `istio-injection: disabled`, `dataplane-mode: ambient`, `use-waypoint: waypoint`, waypoint running, no sidecars, identical enrolment annotations.
- Istio authorization: both ALLOW-only; governs inbound, not egress.
- ServiceEntry/Sidecar: neither namespace has any (only `vehicle-rental` does).
- DNS: identical in both. VPC firewall: no EGRESS rules exist.

**Next step:** ztunnel logs from the **specific node** running a kora pod, during a live reproduction. The DaemonSet replica sampled did not cover the right node.

**Two prior wrong diagnoses, recorded so they are not repeated:**
1. "#202 was caused by the 1500ms `textBudget`" — plausibly connectivity instead; unverified either way.
2. "The PSC endpoint rejects pod-sourced TLS" — **disproved by devai**. An `ip-masq-agent` ConfigMap (`k8s/cluster/ip-masq-agent.yaml`, applied and kept) fixed the TCP layer only; `hostNetwork` reached Vertex but broke Workload Identity (403 scopes) and was reverted.

**Consequence:** prod still runs the resolve engine and the embed backfill on a **personal Gemini API key** — do not revoke it. The food index (prod, 15,116 rows) is now 100% embedded via a laptop-run backfill against Vertex, which is not repeatable in-cluster until this is fixed.

## Repos

- `~/personal/tesserix-new/kora` — app (Go API + Expo mobile)
- `~/personal/tesserix-new/tesserix-k8s` — infra (Helm/ArgoCD). Chart changes REQUIRE a `Chart.yaml` version bump or `chart-testing` fails. `main-protection` requires an approving review, so merges use `--admin`.
