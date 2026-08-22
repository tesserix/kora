-- Paid AI top-ups. Two tables, deliberately separate: an order is a payment
-- record that must survive regardless of what it bought, and an entitlement is
-- consumable state the quota check reads on every request.

-- GST invoices need a consecutive serial per financial year. A sequence gives
-- that without a lock: gaps from rolled-back transactions are acceptable and
-- expected, duplicates are not.
CREATE SEQUENCE ai_invoice_serial;

CREATE TABLE ai_payment_orders (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    pack_code          TEXT NOT NULL,
    -- Every amount is integer paise. The pack's price is COPIED here rather
    -- than looked up at capture time: a price change must never restate what
    -- somebody was already charged.
    base_paise         INTEGER NOT NULL CHECK (base_paise > 0),
    platform_fee_paise INTEGER NOT NULL CHECK (platform_fee_paise >= 0),
    gst_paise          INTEGER NOT NULL CHECK (gst_paise >= 0),
    total_paise        INTEGER NOT NULL CHECK (total_paise > 0),
    currency           TEXT NOT NULL DEFAULT 'INR',
    status             TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'paid', 'failed', 'expired')),
    -- The gateway's own identifiers. cf_order_id is unique so a replayed
    -- webhook cannot create a second order, and NULLs are not compared.
    cf_order_id        TEXT UNIQUE,
    cf_payment_id      TEXT,
    payment_session_id TEXT,
    invoice_number     TEXT UNIQUE,
    paid_at            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A paid order has been through the gateway and has an invoice; anything
    -- else has neither. Half-settled rows are what makes reconciliation guesswork.
    CONSTRAINT ai_payment_orders_paid_check CHECK (
        (status <> 'paid') OR (paid_at IS NOT NULL AND invoice_number IS NOT NULL)
    )
);

CREATE INDEX ai_payment_orders_user_created_idx
    ON ai_payment_orders (user_id, created_at DESC);

CREATE TABLE ai_entitlements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- One entitlement per paid order: the grant IS the order's effect, so the
    -- unique key makes double-granting a replayed webhook impossible at the
    -- storage layer rather than only in application code.
    order_id    UUID NOT NULL UNIQUE REFERENCES ai_payment_orders (id) ON DELETE CASCADE,
    pack_code   TEXT NOT NULL,
    unlimited   BOOLEAN NOT NULL DEFAULT FALSE,
    -- grant_total counts requests; NULL for an unlimited entitlement, which
    -- counts nothing. consumed only ever rises, so remaining is derived.
    grant_total INTEGER CHECK (grant_total IS NULL OR grant_total > 0),
    consumed    INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    daily_cap   INTEGER CHECK (daily_cap IS NULL OR daily_cap > 0),
    starts_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_entitlements_shape_check CHECK (
        (unlimited AND grant_total IS NULL AND daily_cap IS NULL) OR
        (NOT unlimited AND grant_total IS NOT NULL AND daily_cap IS NOT NULL)
    ),
    CONSTRAINT ai_entitlements_window_check CHECK (expires_at > starts_at)
);

-- The hot path: "does this user have anything live right now", ordered so the
-- oldest live entitlement is spent first.
CREATE INDEX ai_entitlements_user_window_idx
    ON ai_entitlements (user_id, expires_at DESC);

-- Per-day spend against a purchased entitlement, so daily_cap can be enforced
-- without scanning usage events. The day is a UTC date, matching the free
-- quota windows in ai_quota_windows.
CREATE TABLE ai_entitlement_days (
    entitlement_id UUID NOT NULL REFERENCES ai_entitlements (id) ON DELETE CASCADE,
    day            DATE NOT NULL,
    request_count  INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (entitlement_id, day)
);
