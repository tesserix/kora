-- Per-circle, per-category sharing (kora#326). Replaces users.share_progress,
-- a single global boolean that gated exactly one category for every friend at
-- once. Visibility is a function of (viewer, category), never one switch.
--
-- Direction falls out of ownership: a circle belongs to its owner and exposes
-- ONLY that owner's data. The reverse grant is a different row in a different
-- circle, so "I share my weight with my spouse" never implies the reverse.
CREATE TABLE share_circles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT share_circles_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX share_circles_owner_name
    ON share_circles (owner_id, lower(btrim(name)));

CREATE TABLE share_circle_members (
    circle_id      UUID NOT NULL REFERENCES share_circles(id) ON DELETE CASCADE,
    member_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (circle_id, member_user_id)
);

-- Resolution asks "which circles containing V are owned by O", so the member
-- side is the leading column of the lookup.
CREATE INDEX idx_share_circle_members_member
    ON share_circle_members (member_user_id, circle_id);

-- `category` is TEXT validated by a Go allow-list, not a Postgres enum:
-- adding a category later must not need ALTER TYPE. Same arrangement as
-- weight_entries_source_check and tracking.Sources -- the two halves are one
-- rule, so a new category must be added to BOTH or writes fail the CHECK.
CREATE TABLE share_grants (
    circle_id  UUID NOT NULL REFERENCES share_circles(id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (circle_id, category),
    CONSTRAINT share_grants_category_check
        CHECK (category IN ('progress', 'body'))
);
