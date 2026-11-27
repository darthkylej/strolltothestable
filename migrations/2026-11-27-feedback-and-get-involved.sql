-- Additive migration for the website Feedback form and Get Involved page.
-- The app also runs these on first use (ensureMessageSchema and
-- ensureVolunteerSchema), so running this by hand is optional.
ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'email';
ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS contact_name TEXT;

CREATE TABLE IF NOT EXISTS volunteer_interest (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  help_areas TEXT[] NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_volunteer_interest_created ON volunteer_interest (created_at DESC);
