# Stroll to the Stable — Nativity Check-In

A Cloudflare Worker (backend + static frontend) backed by Neon Postgres,
Cloudflare Email Service for email, and Cloudflare R2 for photos.

## One-time setup

**1. Neon database**
- Create a new Neon project (or a new database in an existing project).
- Run `schema.sql` against it once (Neon SQL Editor, or `psql "$DATABASE_URL" -f schema.sql`).
- Add the first permanent admin manually after running the schema:
  `INSERT INTO admins (email, is_permanent, added_by) VALUES ('you@example.com', TRUE, NULL);`
- Additional admins can then be added from the app once you've logged in as a permanent admin.

**2. Cloudflare R2 bucket**
```
wrangler r2 bucket create nativity-photos
```
(Matches the `bucket_name` already set in `wrangler.toml`.)

**3. Cloudflare Email**
Outbound mail uses the `EMAIL` send_email binding in `wrangler.toml`; the
sender addresses listed there must be verified on your domain.

**4. Secrets**
```
wrangler secret put DATABASE_URL       # Neon pooled connection string
wrangler secret put SESSION_SECRET     # any long random string, e.g. `openssl rand -hex 32`
```

**5. Install & deploy**
```
npm install
npm run deploy
```

`npm run dev` runs it locally with `wrangler dev` for testing before you deploy.

## How it's put together

- **Neon** holds only small rows of text (users, nativities, pieces,
  admins) — no images, so it stays comfortably inside the free tier
  indefinitely.
- **R2** holds every photo. Uploads are resized to ~1600px/JPEG-75 in the
  browser before they're sent (see `public/js/app.js`), so even at 500
  nativities with photos per piece, total storage should land in the
  1–4 GB range — well inside R2's free tier.
- **Sessions** are signed, stateless cookies (HMAC via Web Crypto) — no
  session table, so "stay logged in for a couple weeks" is just a cookie
  expiry, and switching devices naturally requires logging in again.
- **Regular users** never touch email/OTP — just a short username +
  password emailed at registration. **Admins** always go through
  email + one-time code, regardless of the admin list's size.
- **Annual reuse**: resubmitting clones last year's nativity + pieces
  into a new `pending` row for the current year, which the donor can
  edit before an admin re-verifies and checks it in in person — same
  waiver process as a first-time donor.

## Migration note

If you already ran `schema.sql` against Neon before this update, just run:
```sql
ALTER TABLE nativities ADD COLUMN include_in_tour BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE nativities ADD COLUMN display_photo_key TEXT;
```

## Still to decide / easy to adjust later

- Piece photos are optional by design (per your call on keeping storage
  down) — the input is there in `lend-pieces.html` if a donor wants to
  add one, but it's not required.
- The event year is just `new Date().getFullYear()` at request time —
  fine for a once-a-year event, but flag it if you ever need to run the
  registration window across a year boundary (e.g., opening in December
  for a January event).
- Login, admin-code, registration and forgot-login attempts are throttled
  using the `auth_attempts` table (`src/lib/rateLimit.js`): 8 failed logins
  per username and 30 per IP per 15 minutes, 5 wrong admin codes per
  15 minutes (which also burns the outstanding code), and hourly caps on
  registrations and code/recovery emails. A locked-out donor can still use
  "forgot login".
- Uploads are accepted only as real JPEG/PNG/WebP/GIF files up to 10 MB
  (checked by file signature, not the Content-Type header), and everything
  served from the photo bucket is sent with `nosniff` and a sandbox CSP.
- Submissions are locked to donors once the waiver is signed or an admin has
  checked them in; admins can still edit them.
