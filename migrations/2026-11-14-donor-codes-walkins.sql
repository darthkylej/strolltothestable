-- Donor codes + admin walk-in registration.
-- Additive and safe to re-run. Run this BEFORE deploying the matching code.

-- 1. Every donor gets one permanent code (D-1001, D-1002, ...), kept year to year.
CREATE SEQUENCE IF NOT EXISTS donor_code_seq START 1001;
ALTER TABLE users ADD COLUMN IF NOT EXISTS donor_code TEXT;
WITH o AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM users WHERE donor_code IS NULL
), base AS (
  SELECT COALESCE(MAX(substring(donor_code from 3)::int), 1000) AS b FROM users WHERE donor_code IS NOT NULL
)
UPDATE users u SET donor_code = 'D-' || (base.b + o.rn) FROM o, base WHERE u.id = o.id;
SELECT setval('donor_code_seq', (SELECT COALESCE(MAX(substring(donor_code from 3)::int), 1000) FROM users), true);
ALTER TABLE users ALTER COLUMN donor_code SET DEFAULT 'D-' || nextval('donor_code_seq');
ALTER TABLE users ALTER COLUMN donor_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_donor_code_unique ON users (donor_code);

-- 2. Walk-in donors registered by an admin may have no phone or email.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;            -- optional, printed on paper waivers
ALTER TABLE users ADD COLUMN IF NOT EXISTS city_state_zip TEXT;     -- optional, printed on paper waivers
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_admin TEXT;   -- admin email, NULL for self-registered donors
-- Admin email when an admin set up a paper waiver at the desk (walk-ins), else NULL.
ALTER TABLE nativities ADD COLUMN IF NOT EXISTS paper_by_admin TEXT;

-- 3. Admin search can match the donor code (new column must be added last).
CREATE OR REPLACE VIEW nativity_search AS
SELECT
    n.id,
    n.submission_number,
    n.status,
    n.event_year,
    u.name  AS owner_name,
    u.phone AS owner_phone,
    u.email AS owner_email,
    string_agg(p.description || ' ' || p.condition_notes, ' ') AS piece_text,
    u.donor_code AS owner_donor_code
FROM nativities n
JOIN users u ON u.id = n.owner_user_id
LEFT JOIN nativity_pieces p ON p.nativity_id = n.id
GROUP BY n.id, u.name, u.phone, u.email, u.donor_code;
