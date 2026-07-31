-- Kora in-app feedback. Column names mirror mark8ly's live marketplace-api
-- ticket contract (subject, description, status), plus Kora's own kind,
-- which has no mark8ly equivalent and is the entire point of the feature.
-- ticket_number, submitted_by_name/email and replies are deliberately
-- omitted: this table is capture-only, with no ticket numbering, no
-- submitter-identity fields beyond user_id, and no reply thread.
CREATE TABLE feedback (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    subject      TEXT NOT NULL,
    description  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    app_version  TEXT NOT NULL DEFAULT '',
    platform     TEXT NOT NULL DEFAULT '',
    os_version   TEXT NOT NULL DEFAULT '',
    device_model TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_feedback_user_created ON feedback (user_id, created_at);
CREATE INDEX ix_feedback_status_created ON feedback (status, created_at);
