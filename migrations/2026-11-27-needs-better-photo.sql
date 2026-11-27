-- Additive migration: lets an admin take a nativity off the public Scroll
-- (virtual tour) and mark it as needing a better photo. This is separate
-- from status, which drives check-in and returns. Assigning a new display
-- photo clears it. Nothing existing is changed.
ALTER TABLE nativities ADD COLUMN IF NOT EXISTS needs_better_photo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nativities ADD COLUMN IF NOT EXISTS needs_better_photo_by TEXT;
ALTER TABLE nativities ADD COLUMN IF NOT EXISTS needs_better_photo_at TIMESTAMPTZ;
