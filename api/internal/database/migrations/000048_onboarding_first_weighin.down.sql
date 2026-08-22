-- Reverses 000048_onboarding_first_weighin.up.sql as far as that is honestly
-- possible.
--
-- What this DOES undo: rows the up migration itself inserted are byte-for-
-- byte reproducible from users -- source = 'manual', logged_at EXACTLY equal
-- to that user's users.created_at, and weight_kg EXACTLY equal to that
-- user's users.weight_kg. No other writer sets logged_at to the literal
-- account-creation timestamp (onboarding.Handler.Submit, the only other
-- 'manual' writer as of this migration, stamps logged_at with the time of
-- the onboarding request, which is created_at only in the limit of zero
-- elapsed time between signup and submit). Matching on all three columns
-- deletes exactly the rows this file created and nothing this file didn't.
--
-- What this DOES NOT undo: it cannot distinguish "the value this migration
-- computed" from "a value a real write coincidentally produced" -- if some
-- other process ever writes a manual weigh-in whose logged_at exactly equals
-- the user's created_at and whose weight exactly equals their profile
-- weight, this down migration deletes that row too, even though the up
-- migration didn't create it. That is judged an acceptable, narrow risk
-- given the field is currently pre-launch with a single real user; it would
-- not be acceptable to assume for a database with a real user base.
DELETE FROM weight_entries we
USING users u
WHERE we.user_id = u.id
  AND we.source = 'manual'
  AND we.logged_at = u.created_at
  AND we.weight_kg = u.weight_kg;
