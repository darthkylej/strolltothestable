-- Stroll to the Stable — Nativity Check-In
-- Neon Postgres schema. Run this once against a fresh Neon database.

-- ── Admins ──────────────────────────────────────────────────────────────
-- Membership is just a table of email addresses. The first permanent admin
-- should be added manually after running this schema. Permanent admins can
-- only ever be removed by hand, via SQL; the app layer refuses to touch
-- is_permanent rows.
CREATE TABLE admins (
    email        TEXT PRIMARY KEY,
    is_permanent BOOLEAN NOT NULL DEFAULT FALSE,
    added_by     TEXT,                          -- email of the admin who added them, NULL for the seed row
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add the first permanent admin after running this schema, for example:
-- INSERT INTO admins (email, is_permanent, added_by)
-- VALUES ('you@example.com', TRUE, NULL);

-- One-time codes for admin login. A row is created on request, consumed
-- (deleted) on successful verification, and naturally cleaned up by expiry.
CREATE TABLE admin_otp_codes (
    id         BIGSERIAL PRIMARY KEY,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_otp_email ON admin_otp_codes (email);

-- ── Users (regular donors/loaners) ─────────────────────────────────────
-- Backs the permanent donor code each person keeps from year to year.
CREATE SEQUENCE donor_code_seq START 1001;

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,          -- e.g. garcia1, garcia2
    donor_code    TEXT UNIQUE NOT NULL DEFAULT 'D-' || nextval('donor_code_seq'), -- permanent, e.g. D-1042
    name          TEXT NOT NULL,
    phone         TEXT,                          -- optional for walk-in donors registered by an admin
    email         TEXT,                          -- optional for walk-in donors registered by an admin
    address       TEXT,                          -- optional, printed on paper waivers for walk-ins
    city_state_zip TEXT,
    created_by_admin TEXT,                       -- admin email for walk-in accounts, NULL if self-registered
    password_hash TEXT NOT NULL,                 -- PBKDF2 hash, see src/lib/auth.js
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users (email);
-- One account per email (the email is the login).
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX idx_users_phone ON users (phone);

-- Tracks the next available suffix per last name so usernames increment
-- correctly (garcia1, garcia2, ...) without a race condition between two
-- people registering at the same moment.
CREATE TABLE username_sequences (
    last_name_key TEXT PRIMARY KEY,               -- lowercased, normalized last name
    next_seq      INT NOT NULL DEFAULT 1
);

-- ── Nativities (one row per submission, per year) ──────────────────────
-- A returning donor's "one-click resubmit" creates a NEW row here for the
-- new event_year, cloned from last year's, rather than mutating the old one.
-- That keeps history intact across years.
CREATE TABLE nativities (
    id                BIGSERIAL PRIMARY KEY,
    submission_number TEXT UNIQUE NOT NULL,       -- human-friendly, e.g. STS-2026-0042
    owner_user_id     BIGINT NOT NULL REFERENCES users(id),
    event_year        INT NOT NULL,
    photo_key         TEXT,                       -- R2 object key for the overall photo
    description       TEXT,                       -- what it looks like: materials, colors, size
    story             TEXT,                       -- optional "why it's special"
    piece_count       INT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'returned')),
    include_in_tour    BOOLEAN NOT NULL DEFAULT TRUE, -- owner's opt-out of the public virtual tour
    display_photo_key  TEXT,                       -- worker-uploaded "glamour shot" in the final display spot; takes priority over photo_key in the tour
    waiver_method      TEXT CHECK (waiver_method IN ('digital','paper')), -- how the waiver is (or will be) signed
    paper_by_admin     TEXT,                      -- admin email when the paper waiver was set up at the desk (walk-ins)
    waiver_signed      BOOLEAN NOT NULL DEFAULT FALSE,
    waiver_signed_by   TEXT,                      -- admin email who toggled it
    waiver_signed_at   TIMESTAMPTZ,
    finalized_by       TEXT,                      -- admin email who finalized
    finalized_at       TIMESTAMPTZ,
    returned_at        TIMESTAMPTZ,
    cloned_from_id      BIGINT REFERENCES nativities(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_nativities_owner ON nativities (owner_user_id);
CREATE INDEX idx_nativities_status ON nativities (status);
CREATE INDEX idx_nativities_year ON nativities (event_year);

-- Sequence backing the human-readable submission_number, per event year.
CREATE TABLE submission_number_sequences (
    event_year INT PRIMARY KEY,
    next_seq   INT NOT NULL DEFAULT 1
);

-- ── Pieces (one row per piece within a nativity submission) ────────────
CREATE TABLE nativity_pieces (
    id            BIGSERIAL PRIMARY KEY,
    nativity_id   BIGINT NOT NULL REFERENCES nativities(id) ON DELETE CASCADE,
    piece_number  INT NOT NULL,                  -- display order, 1-based
    description   TEXT NOT NULL,
    condition_notes TEXT NOT NULL,               -- required per piece, e.g. "small chip on base"
    photo_key     TEXT,                          -- optional R2 object key
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (nativity_id, piece_number)
);
CREATE INDEX idx_pieces_nativity ON nativity_pieces (nativity_id);

-- Full text search across the fields admins search by: piece descriptions,
-- owner name/phone/email/donor code. This view keeps the search query simple.
CREATE VIEW nativity_search AS
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


-- ── Shared Message Center ──────────────────────────────────────────────
-- Incoming email to info@, appointments@, and submissions@ is stored here
-- so admins can collaborate without exposing their personal email addresses.
CREATE TABLE message_threads (
    id               BIGSERIAL PRIMARY KEY,
    thread_code      TEXT UNIQUE NOT NULL,
    contact_email    TEXT NOT NULL,
    source_address   TEXT NOT NULL,
    subject          TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'answered', 'closed')),
    last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_threads_status ON message_threads (status);
CREATE INDEX idx_message_threads_contact ON message_threads (lower(contact_email));
CREATE INDEX idx_message_threads_last_message ON message_threads (last_message_at DESC);

CREATE TABLE message_items (
    id               BIGSERIAL PRIMARY KEY,
    thread_id        BIGINT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
    direction        TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sender_email     TEXT NOT NULL,
    admin_email      TEXT,
    body_text        TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    message_id       TEXT,                        -- RFC 5322 Message-ID, for email threading
    references_header TEXT                        -- References header, for email threading
);
CREATE INDEX idx_message_items_thread ON message_items (thread_id, created_at);

-- ── Attempt limiter ────────────────────────────────────────────────────
-- Counts registrations, login failures and admin-code requests/failures so
-- they can be throttled (see src/lib/rateLimit.js). The app also creates this
-- table on first use, so running this section by hand is optional.
CREATE TABLE IF NOT EXISTS auth_attempts (
    id         BIGSERIAL PRIMARY KEY,
    key        TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_key ON auth_attempts (key, created_at);

-- ── Submission numbers are never reused ───────────────────────────────
-- The counter may only go up. Deleting a submission does not free its
-- number, and the counter cannot be lowered or deleted, even by hand.
CREATE OR REPLACE FUNCTION prevent_submission_number_rewind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Submission number counters cannot be deleted: issued numbers are never reused.';
  END IF;
  IF NEW.next_seq < OLD.next_seq THEN
    RAISE EXCEPTION 'Submission number counter for % cannot go backward (% to %): issued numbers are never reused.',
      OLD.event_year, OLD.next_seq, NEW.next_seq;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS submission_number_no_rewind ON submission_number_sequences;
CREATE TRIGGER submission_number_no_rewind
  BEFORE UPDATE OR DELETE ON submission_number_sequences
  FOR EACH ROW EXECUTE FUNCTION prevent_submission_number_rewind();
