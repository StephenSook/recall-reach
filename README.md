# Recall Reach

Recall Reach helps a small resale shop that takes PayPal find out, the morning a product recall is published, which of its past buyers bought the recalled item, so the shop can reach those families and make it right.

**Status:** in development for the PayPal AI Hackathon (November 2026). This README grows as each part ships. Anything not listed under "What works today" is not built yet.

## What works today

- Next.js app skeleton with CI (lint, typecheck, build, and a gitleaks scan of every commit).

## Data sources

- **CPSC recalls:** the U.S. Consumer Product Safety Commission's public Recalls API (`https://www.saferproducts.gov/RestWebServices/Recall`). Real, public data.
- **PayPal:** the PayPal sandbox only. Any sales shown in a demo are sandbox orders, labelled DEMO SHOP / SANDBOX.

## Run it locally

Requirements: Node 22.12 or newer, pnpm 10.

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm build
```
