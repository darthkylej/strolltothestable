-- Additive migration for the Display Photos page (photo bank + matcher).
-- The app also runs these on first use (ensurePhotoBankSchema), so running
-- this by hand is optional. Nothing existing is changed.
CREATE TABLE IF NOT EXISTS photo_bank (
  id BIGSERIAL PRIMARY KEY,
  photo_key TEXT UNIQUE NOT NULL,          -- R2 key under photo-bank/
  fingerprint TEXT,                        -- small colour fingerprint made in the browser
  taken_at TIMESTAMPTZ,                    -- from the photo's EXIF, else the file time
  original_name TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_by TEXT,
  matched_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_photo_bank_taken ON photo_bank (taken_at, id);

-- Fingerprints of donor photos (nativities.photo_key), used for best guesses.
CREATE TABLE IF NOT EXISTS photo_fingerprints (
  photo_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Picks for each bank photo (suggestions only; an admin chooses the match).
CREATE TABLE IF NOT EXISTS photo_bank_suggestions (
  bank_id BIGINT NOT NULL REFERENCES photo_bank(id) ON DELETE CASCADE,
  nativity_id BIGINT NOT NULL REFERENCES nativities(id) ON DELETE CASCADE,
  rank INT NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bank_id, nativity_id)
);
ALTER TABLE photo_bank ADD COLUMN IF NOT EXISTS suggest_note TEXT;
ALTER TABLE photo_bank ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ;

-- Proposed matches for nativities taken off the Scroll (Approve Photo Matches page).
ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT '';
ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS rotate INT NOT NULL DEFAULT 0;
ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS previous_display_key TEXT;
ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
