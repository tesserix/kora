-- A portion the system chose rather than one derived from real data or stated
-- by the user. The hedge shown at capture (DetectedCard, Otto's summary) died
-- at confirm, so the diary rendered a guess as a plain figure indistinguishable
-- from a weighed one — see #138.
--
-- DEFAULT false is the correct reading for every existing row: they predate the
-- flag and nothing recorded that their portions were assumed. Inventing a value
-- for them would be worse than the default.
ALTER TABLE food_logs
    ADD COLUMN portion_assumed BOOLEAN NOT NULL DEFAULT false;
