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
