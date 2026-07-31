-- Kora in-app feedback. Column names mirror the platform tickets-service
-- Ticket contract (kind->type, body->description, user_id->created_by, the
-- client columns->metadata) so a later tesserix-home integration is a
-- projection rather than a redesign. tenant_id/product_id/application_id are
-- deliberately absent: Kora is a single-product app with no tenancy, so those
-- are constants supplied at integration time.
CREATE TABLE feedback (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    app_version  TEXT NOT NULL DEFAULT '',
    platform     TEXT NOT NULL DEFAULT '',
    os_version   TEXT NOT NULL DEFAULT '',
    device_model TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_feedback_user_created ON feedback (user_id, created_at);
CREATE INDEX ix_feedback_status_created ON feedback (status, created_at);
