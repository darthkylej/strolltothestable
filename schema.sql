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
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,          -- e.g. garcia1, garcia2
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,                 -- PBKDF2 hash, see src/lib/auth.js
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users (email);
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
    story             TEXT,                       -- optional "why it's special"
    piece_count       INT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'returned')),
    include_in_tour    BOOLEAN NOT NULL DEFAULT TRUE, -- owner's opt-out of the public virtual tour
    display_photo_key  TEXT,                       -- worker-uploaded "glamour shot" in the final display spot; takes priority over photo_key in the tour
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
-- owner name/phone/email. This view keeps the search query simple.
CREATE VIEW nativity_search AS
SELECT
    n.id,
    n.submission_number,
    n.status,
    n.event_year,
    u.name  AS owner_name,
    u.phone AS owner_phone,
    u.email AS owner_email,
    string_agg(p.description || ' ' || p.condition_notes, ' ') AS piece_text
FROM nativities n
JOIN users u ON u.id = n.owner_user_id
LEFT JOIN nativity_pieces p ON p.nativity_id = n.id
GROUP BY n.id, u.name, u.phone, u.email;
