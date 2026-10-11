-- Kora product & pricing rollup (kora#43).
--
--   kubectl exec -n kora kora-postgres-1 -- psql -q -d kora_db -f - < this
--
-- These are the per-user aggregates Prometheus cannot answer. The exporter
-- (api/internal/metrics) already carries the estate-wide counters — calls,
-- cost, logs by source — but a median or a per-user distribution is
-- high-cardinality by definition and does not belong in a label. So the
-- headline COGS and value numbers, the ones that gate pricing (#41) and the
-- budget policy (#44), are read from here.
--
-- ## Read this before quoting any number below
--
-- **Cache hits are invisible.** A resolve served from the Redis cache makes no
-- provider call, so it writes NO ai_usage_events row. "Calls per user" is
-- therefore calls that MISSED the cache — which is the right COGS number, and
-- the wrong number for "how often did someone resolve something". #44's cache
-- saving cannot be computed from this table at all; it would need a hit
-- counter that does not exist.
--
-- **Failed calls are included, deliberately.** A call that errored or timed
-- out still consumed billed tokens and provider quota. Query 2 splits by
-- outcome so the two readings are both available; every other query counts
-- them, because an invoice does.
--
-- **Corrections are undercounted.** See query 7.
SET statement_timeout = '120s';

-- The window every query below uses. 30 days is the MAU definition; edit here
-- and it changes everywhere, so two numbers in one report can never describe
-- two different periods.
\set days 30

-- =====================================================================
-- 0. What the window actually contains.
--
-- Run this first and read it before anything else. Kora is pre-launch with
-- one real account; every number below is computed over whatever this row
-- says, and a median over three users is a description of three people, not
-- a forecast. An empty window is a real answer and must not be mistaken for
-- a broken query.
-- =====================================================================
SELECT :days                                              AS window_days,
       (now() - make_interval(days => :days))::date       AS window_from,
       now()::date                                        AS window_to,
       (SELECT count(DISTINCT user_id) FROM food_logs
         WHERE logged_at >= now() - make_interval(days => :days)) AS logging_users,
       (SELECT count(*) FROM food_logs
         WHERE logged_at >= now() - make_interval(days => :days)) AS logs,
       (SELECT count(*) FROM ai_usage_events
         WHERE created_at >= now() - make_interval(days => :days)) AS ai_calls,
       (SELECT count(*) FROM users)                       AS users_total;

-- =====================================================================
-- 1. THE COGS NUMBER (#43's headline, gates #41).
--
-- AI calls per monthly-active user, and true spend per user.
--
-- "Monthly-active" is defined as "logged at least one food in the window".
-- Deliberately NOT "made an AI call": a user who logs entirely by barcode and
-- manual search is active and costs nothing, and defining them out of the
-- denominator would inflate cost/user and price the product off a subset of
-- its own users.
--
-- Users active with ZERO AI calls are therefore included as zeroes (the LEFT
-- JOIN). Dropping them is the single easiest way to overstate COGS.
-- =====================================================================
WITH active AS (
    SELECT DISTINCT user_id
    FROM food_logs
    WHERE logged_at >= now() - make_interval(days => :days)
),
per_user AS (
    SELECT a.user_id,
           count(e.id)                       AS calls,
           coalesce(sum(e.cost_usd_est), 0)  AS cost_usd
    FROM active a
    LEFT JOIN ai_usage_events e
           ON e.user_id = a.user_id
          AND e.created_at >= now() - make_interval(days => :days)
    GROUP BY a.user_id
)
SELECT count(*)                                                        AS active_users,
       round(avg(calls)::numeric, 2)                                   AS mean_calls,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY calls)              AS median_calls,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY calls)              AS p90_calls,
       max(calls)                                                      AS max_calls,
       round(sum(cost_usd)::numeric, 4)                                AS total_cost_usd,
       round(avg(cost_usd)::numeric, 4)                                AS mean_cost_usd,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::numeric, 4) AS median_cost_usd,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY cost_usd)::numeric, 4) AS p90_cost_usd
FROM per_user;

-- =====================================================================
-- 2. Where the money goes: by call type, model and outcome.
--
-- The `class` split the exporter uses (resolution vs derived, see
-- api/internal/metrics/labels.go) is reproduced here so the dashboard and the
-- rollup cannot disagree about which calls are the headline ones. Keep the
-- CASE in step with classByCallType — it is the one place this file
-- duplicates a decision that lives in Go.
-- =====================================================================
SELECT CASE
         WHEN call_type IN ('decompose', 'embed') THEN 'derived'
         ELSE 'resolution'
       END                                        AS class,
       call_type,
       model,
       outcome,
       count(*)                                   AS calls,
       round(sum(cost_usd_est)::numeric, 4)       AS cost_usd,
       round(avg(latency_ms)::numeric, 0)         AS mean_latency_ms,
       sum(tokens_in)                             AS tokens_in,
       sum(tokens_out)                            AS tokens_out
FROM ai_usage_events
WHERE created_at >= now() - make_interval(days => :days)
GROUP BY 1, 2, 3, 4
ORDER BY cost_usd DESC NULLS LAST, calls DESC;

-- =====================================================================
-- 3. THE VALUE NUMBER (#43's second, sizes willingness-to-pay).
--
-- Log distribution by source. `source` is written by the app
-- (apps/mobile/app/capture.tsx sourceForMode) and constrained by a CHECK; the
-- authoritative list is metrics/labels.go knownSources.
--
-- ai_barcode is AI-NAMED BUT ZERO-COGS: a barcode is an OpenFoodFacts lookup,
-- not a model call. It is counted as AI-sourced for the value question ("did
-- the magic get used") and excluded from COGS, which is why the two shares
-- below differ and why neither alone answers the pricing question.
-- =====================================================================
SELECT source,
       count(*)                                                        AS logs,
       round(100.0 * count(*) / nullif(sum(count(*)) OVER (), 0), 1)   AS pct_of_logs,
       count(DISTINCT user_id)                                         AS users
FROM food_logs
WHERE logged_at >= now() - make_interval(days => :days)
GROUP BY source
ORDER BY logs DESC;

-- 3b. The two shares as single numbers, so they can be tracked over time
--     without re-deriving them from the table above by hand.
SELECT count(*)                                                         AS logs,
       count(*) FILTER (WHERE source = 'ai_photo')                      AS photo_logs,
       round(100.0 * count(*) FILTER (WHERE source = 'ai_photo')
             / nullif(count(*), 0), 1)                                  AS photo_share_pct,
       count(*) FILTER (WHERE source IN ('ai_photo', 'ai_text', 'ai_voice')) AS model_backed_logs,
       round(100.0 * count(*) FILTER (WHERE source IN ('ai_photo', 'ai_text', 'ai_voice'))
             / nullif(count(*), 0), 1)                                  AS model_backed_share_pct,
       -- Zero-COGS logs: the free tier's viability in one number.
       round(100.0 * count(*) FILTER (WHERE source IN ('ai_barcode', 'manual', 'memory', 'meal', 'recipe'))
             / nullif(count(*), 0), 1)                                  AS zero_cogs_share_pct
FROM food_logs
WHERE logged_at >= now() - make_interval(days => :days);

-- =====================================================================
-- 4. AI-heavy users — the conversion targets #43 asks to surface.
--
-- Per-user, so it is deliberately not something Prometheus could answer.
-- Ordered by spend rather than by call count: a handful of photo resolves
-- costs more than many text ones, and it is spend that sets the floor.
-- =====================================================================
WITH per_user AS (
    SELECT u.id AS user_id,
           count(e.id)                                                   AS ai_calls,
           coalesce(sum(e.cost_usd_est), 0)                              AS cost_usd,
           (SELECT count(*) FROM food_logs l
             WHERE l.user_id = u.id
               AND l.logged_at >= now() - make_interval(days => :days))  AS logs
    FROM users u
    LEFT JOIN ai_usage_events e
           ON e.user_id = u.id
          AND e.created_at >= now() - make_interval(days => :days)
    GROUP BY u.id
)
SELECT user_id,
       logs,
       ai_calls,
       round(cost_usd::numeric, 4)                             AS cost_usd,
       round((ai_calls::numeric / nullif(logs, 0)), 2)         AS calls_per_log
FROM per_user
WHERE ai_calls > 0 OR logs > 0
ORDER BY cost_usd DESC, ai_calls DESC
LIMIT 50;

-- =====================================================================
-- 5. Retention — the guardrail #43 names and #328 sets a number on
--    ("≥50% of testers still logging on day 14").
--
-- Day-N is measured from each user's FIRST log, not from signup: someone who
-- installed and never logged never started, and counting them as churn on day
-- 1 measures onboarding rather than retention.
-- =====================================================================
WITH first_log AS (
    SELECT user_id, min(logged_at) AS started_at
    FROM food_logs
    GROUP BY user_id
),
cohort AS (
    SELECT f.user_id, f.started_at
    FROM first_log f
    -- Only users whose window has fully elapsed, so a user who started
    -- yesterday is not counted as having failed to reach day 14.
    WHERE f.started_at <= now() - interval '30 days'
)
SELECT count(*) AS cohort_users,
       count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM food_logs l WHERE l.user_id = c.user_id
             AND l.logged_at >= c.started_at + interval '1 day'
             AND l.logged_at <  c.started_at + interval '2 days'))  AS d1,
       count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM food_logs l WHERE l.user_id = c.user_id
             AND l.logged_at >= c.started_at + interval '7 days'
             AND l.logged_at <  c.started_at + interval '8 days'))  AS d7,
       count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM food_logs l WHERE l.user_id = c.user_id
             AND l.logged_at >= c.started_at + interval '14 days'
             AND l.logged_at <  c.started_at + interval '15 days')) AS d14,
       count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM food_logs l WHERE l.user_id = c.user_id
             AND l.logged_at >= c.started_at + interval '30 days'
             AND l.logged_at <  c.started_at + interval '31 days')) AS d30
FROM cohort c;

-- =====================================================================
-- 6. TIME-TO-LOG — kora#43's north star, "<10s median".
--
-- Measurable since kora#482. `client_log_ms` has existed since the original
-- schema but only app/log.tsx (the MANUAL search screen) ever populated it, so
-- production had 10 logs and zero timed: every real log arrived through a
-- capture path that never set it. capture.tsx now stamps the clock in
-- beginResolve(), which every path (photo, voice, message, barcode) funnels
-- through, and reads it at CONFIRM — so a log queued offline still reports how
-- long the USER waited, not how long the queue held it.
--
-- READ THE COVERAGE COLUMN BEFORE THE MEDIAN. NULL means "not measured", which
-- is NOT zero: an instant log from a pin has no capture phase, and a client
-- older than kora#482 reports nothing. A median over a small timed subset is a
-- statement about that subset, so `timed` and `untimed` are reported beside it
-- rather than left for someone to assume.
--
-- Values the server could not believe are already NULL, not clamped:
-- plausibleClientLogMs drops anything negative or over an hour, because a
-- clamped value looks like a real observation and would pile a fake mode up at
-- exactly the ceiling.
-- =====================================================================
SELECT count(*)                                                    AS logs,
       count(client_log_ms)                                        AS timed,
       count(*) - count(client_log_ms)                             AS untimed,
       round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY client_log_ms) FILTER (WHERE client_log_ms IS NOT NULL)::numeric / 1000, 1)
                                                                   AS median_seconds,
       round(percentile_cont(0.9) WITHIN GROUP (
             ORDER BY client_log_ms) FILTER (WHERE client_log_ms IS NOT NULL)::numeric / 1000, 1)
                                                                   AS p90_seconds
FROM food_logs
WHERE created_at >= now() - make_interval(days => :days);

-- The same split by source, because the north star is really a claim about the
-- AI paths: a `memory` or pin log is one tap and will always be fast, so
-- averaging it in flatters the number the target is about.
SELECT source,
       count(*)                        AS logs,
       count(client_log_ms)            AS timed,
       round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY client_log_ms) FILTER (WHERE client_log_ms IS NOT NULL)::numeric / 1000, 1)
                                       AS median_seconds
FROM food_logs
WHERE created_at >= now() - make_interval(days => :days)
GROUP BY source
ORDER BY count(*) DESC;

-- 7. THE METRIC THAT MATTERS MOST (#328) — "the user corrected the guess".
--
-- Every correction writes a personal food_aliases row: EditLog is the only
-- production caller of nutrition.AddAlias, keyed on the log's own
-- input_phrase. So the labelled-failure set has been accumulating all along,
-- and this is how to read it.
--
-- ## It UNDERCOUNTS, and by how much is not knowable from here
--
-- AddAlias is an UPSERT (ON CONFLICT (user_id, lower(alias)) DO UPDATE), so a
-- user who corrects "toast" three times leaves ONE row, and created_at is the
-- FIRST correction rather than the latest. This therefore counts DISTINCT
-- CORRECTED PHRASES per user, not correction events.
--
-- Consequence for #328's "resolution correct on first try for ≥90% of logs":
-- the number below is a FLOOR on the correction rate, so treat ≥90% here as
-- necessary and not sufficient. Measuring it properly needs a correction event
-- recorded per edit — the same gap as #459, and worth solving once for both.
-- =====================================================================
SELECT count(*)                                                         AS corrected_phrases,
       count(DISTINCT user_id)                                          AS users_correcting,
       (SELECT count(*) FROM food_logs
         WHERE logged_at >= now() - make_interval(days => :days))       AS logs_in_window,
       round(100.0 * count(*) / nullif((SELECT count(*) FROM food_logs
         WHERE logged_at >= now() - make_interval(days => :days)), 0), 1)
                                                                        AS floor_correction_rate_pct
FROM food_aliases
WHERE user_id IS NOT NULL
  AND created_at >= now() - make_interval(days => :days);

-- 7b. WHICH foods fail — the eval set #328 wants, and the input #234, #235,
--     #219 and #212 each need. Ordered by how many distinct people corrected
--     to the same food: one person's idiosyncratic phrasing is noise, three
--     people converging on the same correction is a bug in the index.
SELECT f.name                          AS corrected_to,
       f.brand,
       count(*)                        AS corrections,
       count(DISTINCT a.user_id)       AS users,
       min(a.created_at)::date         AS first_seen,
       array_agg(DISTINCT a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL) AS phrases
FROM food_aliases a
JOIN food_items f ON f.id = a.food_item_id
WHERE a.user_id IS NOT NULL
GROUP BY f.id, f.name, f.brand
ORDER BY users DESC, corrections DESC
LIMIT 50;

-- =====================================================================
-- 7c. THE REAL FIRST-TRY RATE (kora#459), and where the resolver loses.
--
-- food_resolution_outcomes carries one row per resolve ATTEMPT, which is what
-- makes this a rate rather than a count: the denominator is attempts, and a
-- successful resolve leaves no other trace anywhere (a cache hit never reaches
-- the provider, so ai_usage_events cannot supply it either).
--
-- ## Why cache and alias are excluded from the denominator
--
-- An `alias` hit is a phrase the resolver got wrong ONCE ALREADY and a human
-- fixed. Counting it as a first-try success would let the correction loop
-- improve the very metric that measures whether corrections are still needed.
-- A `cache` hit did not exercise the resolver at all. Both are still counted
-- in `attempts` above, because they did happen -- they are just not evidence
-- either way about whether the resolver works.
--
-- Mirrors resolveoutcome.Rates.FirstTryRate exactly. If the two ever disagree,
-- the Go one is authoritative: it is the one with tests.
--
-- NULL rather than 0 over an empty denominator. A rate over no attempts is not
-- 0%, and rendering it as one is how an empty window looks like total failure.
-- =====================================================================
SELECT count(*)                                                          AS attempts,
       count(*) FILTER (WHERE kind IN ('cache','alias'))                 AS not_resolver_work,
       count(*) FILTER (WHERE kind = 'resolved')                         AS first_try,
       count(*) FILTER (WHERE kind IN ('below_floor','no_match'))        AS needs_human,
       round(100.0 * count(*) FILTER (WHERE kind = 'resolved')
             / nullif(count(*) FILTER (WHERE kind NOT IN ('cache','alias')), 0), 1)
                                                                         AS first_try_rate_pct
FROM food_resolution_outcomes
WHERE created_at >= now() - make_interval(days => :days);

-- 7d. Where the resolver loses, by kind and mode.
--
-- below_floor and no_match are the two that demand OPPOSITE fixes: the index
-- has near-misses (lower the floor) versus the index has nothing (add data).
-- Conflating them is the exact confusion #459 was opened to end, so they are
-- never summed into one "failures" number here.
SELECT kind,
       mode,
       count(*)                                                          AS attempts,
       round(100.0 * count(*) / nullif(sum(count(*)) OVER (), 0), 1)     AS pct,
       round(avg(top_score)::numeric, 3)                                 AS mean_top_score,
       count(*) FILTER (WHERE status IN ('open','in_progress'))          AS still_open
FROM food_resolution_outcomes
WHERE created_at >= now() - make_interval(days => :days)
GROUP BY kind, mode
ORDER BY attempts DESC;

-- 7e. The phrases the index cannot serve -- the eval set, from the attempt
--     side rather than the correction side.
--
-- 7b sees only failures a user cared enough to CORRECT. This sees every
-- failure, including the ones where they gave up. The gap between the two is
-- itself worth watching.
SELECT coalesce(phrase, '(photo -- no phrase)')                          AS phrase,
       kind,
       count(*)                                                          AS attempts,
       count(DISTINCT user_id)                                           AS users,
       max(created_at)::date                                             AS last_seen
FROM food_resolution_outcomes
WHERE created_at >= now() - make_interval(days => :days)
  AND kind IN ('below_floor','no_match')
GROUP BY 1, 2
ORDER BY users DESC, attempts DESC
LIMIT 50;

-- =====================================================================
-- 8. Food index health, mirroring the exporter's gauges.
--
-- Here as well as in Prometheus because it is the one number that silently
-- degrades resolution quality: cmd/embed exits 0 when it gives up, so the Job
-- reports Complete having embedded nothing (#97). If `not_embedded` is
-- non-zero, every number in query 7 describes an index that was not fully
-- searchable when those corrections were made.
-- =====================================================================
SELECT count(*)                                          AS food_items,
       count(*) FILTER (WHERE embedding IS NOT NULL)     AS embedded,
       count(*) FILTER (WHERE embedding IS NULL)         AS not_embedded,
       count(*) FILTER (WHERE deleted_at IS NOT NULL)    AS retired
FROM food_items;
