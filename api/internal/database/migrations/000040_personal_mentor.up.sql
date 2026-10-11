CREATE TABLE mentor_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    motivation TEXT NOT NULL DEFAULT '',
    dietary_preferences TEXT NOT NULL DEFAULT '',
    allergies TEXT NOT NULL DEFAULT '',
    coaching_style TEXT NOT NULL DEFAULT 'supportive',
    reminder_intensity TEXT NOT NULL DEFAULT 'balanced',
    quiet_start_minute SMALLINT NOT NULL DEFAULT 1320,
    quiet_end_minute SMALLINT NOT NULL DEFAULT 420,
    health_steps_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    health_sleep_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    health_workouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mentor_profiles_coaching_style_check
        CHECK (coaching_style IN ('supportive', 'direct', 'educational', 'accountability')),
    CONSTRAINT mentor_profiles_reminder_intensity_check
        CHECK (reminder_intensity IN ('light', 'balanced', 'frequent')),
    CONSTRAINT mentor_profiles_quiet_start_check
        CHECK (quiet_start_minute BETWEEN 0 AND 1439),
    CONSTRAINT mentor_profiles_quiet_end_check
        CHECK (quiet_end_minute BETWEEN 0 AND 1439)
);

CREATE TABLE health_daily_summaries (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_date DATE NOT NULL,
    timezone TEXT NOT NULL,
    steps INTEGER,
    sleep_minutes INTEGER,
    workout_minutes INTEGER,
    source TEXT NOT NULL DEFAULT 'healthkit',
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, local_date),
    CONSTRAINT health_daily_summaries_steps_check CHECK (steps IS NULL OR steps >= 0),
    CONSTRAINT health_daily_summaries_sleep_check
        CHECK (sleep_minutes IS NULL OR sleep_minutes BETWEEN 0 AND 1440),
    CONSTRAINT health_daily_summaries_workout_check
        CHECK (workout_minutes IS NULL OR workout_minutes BETWEEN 0 AND 1440),
    CONSTRAINT health_daily_summaries_has_metric_check
        CHECK (steps IS NOT NULL OR sleep_minutes IS NOT NULL OR workout_minutes IS NOT NULL),
    CONSTRAINT health_daily_summaries_source_check CHECK (source = 'healthkit')
);

CREATE TABLE mentor_commitments (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    cadence TEXT NOT NULL,
    weekdays_mask SMALLINT NOT NULL DEFAULT 127,
    start_minute SMALLINT NOT NULL,
    interval_minutes SMALLINT,
    end_minute SMALLINT,
    timezone TEXT NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE,
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'user',
    agent_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mentor_commitments_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
    CONSTRAINT mentor_commitments_kind_check CHECK (kind IN ('hydration', 'walking', 'meal', 'custom')),
    CONSTRAINT mentor_commitments_cadence_check CHECK (cadence IN ('fixed', 'interval')),
    CONSTRAINT mentor_commitments_weekdays_check CHECK (weekdays_mask BETWEEN 1 AND 127),
    CONSTRAINT mentor_commitments_start_check CHECK (start_minute BETWEEN 0 AND 1439),
    CONSTRAINT mentor_commitments_end_check CHECK (end_minute IS NULL OR end_minute BETWEEN 0 AND 1439),
    CONSTRAINT mentor_commitments_schedule_check CHECK (
        (cadence = 'fixed' AND interval_minutes IS NULL AND end_minute IS NULL)
        OR
        (cadence = 'interval' AND interval_minutes BETWEEN 30 AND 720 AND end_minute > start_minute)
    ),
    CONSTRAINT mentor_commitments_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT mentor_commitments_status_check CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT mentor_commitments_source_check
        CHECK (source IN ('user', 'coach', 'nutritionist', 'meal_planner'))
);

CREATE INDEX mentor_commitments_user_status_idx
    ON mentor_commitments (user_id, status, starts_on, id);

CREATE TABLE mentor_check_ins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commitment_id UUID NOT NULL REFERENCES mentor_commitments(id) ON DELETE CASCADE,
    scheduled_for TIMESTAMPTZ NOT NULL,
    local_date DATE NOT NULL,
    action TEXT NOT NULL,
    snoozed_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mentor_check_ins_occurrence_unique UNIQUE (commitment_id, scheduled_for),
    CONSTRAINT mentor_check_ins_action_check CHECK (action IN ('done', 'skipped', 'snoozed')),
    CONSTRAINT mentor_check_ins_snooze_check CHECK (
        (action = 'snoozed' AND snoozed_until > scheduled_for)
        OR
        (action IN ('done', 'skipped') AND snoozed_until IS NULL)
    )
);

CREATE INDEX mentor_check_ins_user_day_idx
    ON mentor_check_ins (user_id, local_date DESC, scheduled_for DESC);
