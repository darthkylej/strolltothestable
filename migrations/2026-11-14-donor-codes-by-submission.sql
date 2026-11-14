-- Donor codes follow the order of first nativity submission.
-- Codes are issued by the app (ensureDonorCode) when a donor's first nativity
-- gets a submission number, so accounts with no submissions have no code.
ALTER TABLE users ALTER COLUMN donor_code DROP DEFAULT;
ALTER TABLE users ALTER COLUMN donor_code DROP NOT NULL;
UPDATE users SET donor_code = NULL;
WITH firsts AS (
  SELECT owner_user_id, min(submission_number) AS first_number
  FROM nativities WHERE submission_number NOT LIKE 'DRAFT-%'
  GROUP BY owner_user_id
), ordered AS (
  SELECT owner_user_id, row_number() OVER (ORDER BY first_number, owner_user_id) AS rn FROM firsts
)
UPDATE users u SET donor_code = 'D-' || (1000 + o.rn) FROM ordered o WHERE u.id = o.owner_user_id;
SELECT setval('donor_code_seq', (SELECT COALESCE(MAX(substring(donor_code from 3)::int), 1000) FROM users), true);
