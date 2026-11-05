# Recall Reach

Recall Reach helps a small resale shop that takes PayPal find out, the morning a product recall is published, which of its past buyers bought the recalled item, so the shop can reach those families and make it right.

**Status:** in development for the PayPal AI Hackathon (November 2026). This README grows as each part ships. Anything not listed under "What works today" is not built yet.

## What works today

- **CPSC recall loader.** Pulls recalls from the CPSC Recalls API by date range, validates every record, and upserts it into Postgres with a SHA-256 of the exact snapshot. Every pull is logged in `cpsc_pulls`. A record that fails validation is reported, never dropped. A response that is not a JSON array (such as a firewall page served with HTTP 200), or that contains recalls outside the requested dates, is refused.
- **All 2025 and 2026 recalls loaded:** 420 for 2025 and 514 for 2026 through November 5, 2026 (`pnpm load:recalls`).
- **PayPal webhook endpoint** (`POST /api/paypal/webhook`). Verifies PayPal's RSA signature against PayPal's own certificate, accepts certificates only from PayPal sandbox hosts, stores each verified event once (PayPal's resource id is kept only as a hash), refuses a transmission id reused for a different event, and caps the body size while reading.
- **Health endpoint** (`GET /api/health`). Database reachability, recall counts by year, the last CPSC pull, and webhook status. No secrets.
- **CI** on every push: lint, typecheck, tests, build, and a gitleaks scan of the full history.

## Data sources

- **CPSC recalls:** the U.S. Consumer Product Safety Commission's public Recalls API (`https://www.saferproducts.gov/RestWebServices/Recall`). Real, public data.
- **PayPal:** the PayPal sandbox only. Any sales shown in a demo are sandbox orders, labelled DEMO SHOP / SANDBOX.

## Run it locally

Requirements: Node 22.12 or newer, pnpm 10, and a Postgres database (the app uses Neon).

```bash
pnpm install
cp .env.example .env.local     # then fill in real values
pnpm db:migrate                 # apply db/migrations to DATABASE_URL
pnpm load:recalls               # load 2025 and 2026 recalls (or: pnpm load:recalls 2024)
pnpm dev                        # http://localhost:3000
```

Checks (the same ones CI runs):

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit and database tests; Postgres runs in-process (PGlite), no setup needed
pnpm build
pnpm test:live   # optional: calls the real CPSC API
```

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | `server/db/pg.ts` | Postgres connection string |
| `PAYPAL_WEBHOOK_ID` | `app/api/paypal/webhook/route.ts` | The sandbox app's webhook id, part of every signature PayPal sends |

## Credits

- PayPal webhook signature verification is adapted from [paypaldev/video-bytemonkio-paypal-tutorial](https://github.com/paypaldev/video-bytemonkio-paypal-tutorial) (MIT License, Copyright (c) 2026 ByteMonk LLC).
