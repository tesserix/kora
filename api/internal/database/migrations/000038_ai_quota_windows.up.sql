CREATE TABLE ai_quota_windows (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_kind TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_quota_windows_pkey PRIMARY KEY (user_id, window_kind, window_start),
    CONSTRAINT ai_quota_windows_kind_check CHECK (window_kind IN ('day', 'week', 'month')),
    CONSTRAINT ai_quota_windows_count_check CHECK (request_count >= 0)
);

CREATE INDEX idx_ai_quota_windows_start ON ai_quota_windows (window_start);

INSERT INTO ai_quota_windows (user_id, window_kind, window_start, request_count)
SELECT
    user_id,
    'day',
    date_trunc('day', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
    COUNT(*)::INTEGER
FROM ai_usage_events
WHERE user_id IS NOT NULL
  AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
GROUP BY user_id, date_trunc('day', created_at AT TIME ZONE 'UTC')
UNION ALL
SELECT
    user_id,
    'week',
    date_trunc('week', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
    COUNT(*)::INTEGER
FROM ai_usage_events
WHERE user_id IS NOT NULL
  AND created_at >= date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
GROUP BY user_id, date_trunc('week', created_at AT TIME ZONE 'UTC')
UNION ALL
SELECT
    user_id,
    'month',
    date_trunc('month', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
    COUNT(*)::INTEGER
FROM ai_usage_events
WHERE user_id IS NOT NULL
  AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
GROUP BY user_id, date_trunc('month', created_at AT TIME ZONE 'UTC');
