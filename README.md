# Recall Reach

When a baby product gets recalled after a small resale shop sold it, Recall Reach finds the order, helps the shop reach the family, and refunds the sale through PayPal when the sale came after the recall.

**Try it, no login:** https://recall-reach-web-e022.onrender.com/judge

Built for the PayPal AI Hackathon, November 2026. The recalls are real CPSC records. The shop is a demo, labelled as one, and its payments are real PayPal sandbox payments. No real shop or family has used this yet.

## What it does

1. **Checks past sales against real recalls.** It pulls recalls from CPSC every 15 minutes and checks each shop's order lines against them with rules, in the app. A shop that uploaded before a recall came in gets that recall on its next visit from the same browser.
2. **Says when it can't tell.** Most recalls cover certain models, dates or versions, and an order line rarely says which one it was. Those read "Can't tell yet", never a false "not recalled".
3. **Asks the family what the recall needs.** Claude writes one question resting on words CPSC really wrote, and the check rejects a question whose quote isn't in the record. The owner approves it before it goes out.
4. **Leaves every message and refund to a person.** The owner approves it, the notice opens in the shop's own mail, and they send it. The family answers on a phone page, and the seller's card changes.
5. **Refunds only what it should.** A sale after the recall date, within 180 days of the payment, for the exact amount the owner approved. The refund goes through PayPal Agent Toolkit with one request id, and the page reconciles our record against PayPal's refund, PayPal's payment and the webhook.

## See it for yourself

| Page | What it shows |
|---|---|
| [`/judge`](https://recall-reach-web-e022.onrender.com/judge) | A numbered route through all of it |
| [`/replay`](https://recall-reach-web-e022.onrender.com/replay) | Every recall from 2025 on, checked against the demo shop in one run, with a clock and a link to recount it |
| [`/eval`](https://recall-reach-web-e022.onrender.com/eval) | Held-out numbers beside a word-match baseline, with intervals and their limits |
| [`/safety`](https://recall-reach-web-e022.onrender.com/safety) | Five attacks tried against the real code |
| [`/evidence/paypal`](https://recall-reach-web-e022.onrender.com/evidence/paypal), [`/evidence/ag-grid`](https://recall-reach-web-e022.onrender.com/evidence/ag-grid) | Each claim, and the file that does it. A test fails if the code leaves that file |
| [`/check`](https://recall-reach-web-e022.onrender.com/check) | A shop's own order file, deleted on request or after 7 days |
| [`/privacy`](https://recall-reach-web-e022.onrender.com/privacy) | What is kept, and text a shop can copy |

From a terminal:

```bash
curl https://recall-reach-web-e022.onrender.com/api/health
curl "https://recall-reach-web-e022.onrender.com/api/recalls/today/matches?shop=demo"
curl "https://recall-reach-web-e022.onrender.com/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083"
```

A recall's sales are drawn on a [Bryntum](https://bryntum.com/products/scheduler/) timeline, reached from a sale's card in the queue. Each bar is a sale's 180-day refund window, from the shop's own order date, with lines at the recall date and today, so you can see why a sale gets a notice, a check or a refund. PayPal's own payment date still decides before a refund goes out.

Each recent recall's product name also goes to [Channel3](https://recall-reach-web-e022.onrender.com/evidence/channel3), from the hourly job, to see what the market lists under it. A page like [`/sweep/27072`](https://recall-reach-web-e022.onrender.com/sweep/27072) shows same-brand, same-product results as candidates for a person to review. None is called recalled, and no seller is kept. Only CPSC's public words go out.

For agents and marketplaces, the same check is an MCP tool, `check_recall`, on [`/api/mcp`](https://recall-reach-web-e022.onrender.com/evidence/api). A result names a recall to read, not a finding about the item. No key, and nothing sent is stored. The API is described in [`openapi.yaml`](openapi.yaml), and a test checks it against the code.

```json
{ "mcpServers": { "recall-reach": { "type": "http", "url": "https://recall-reach-web-e022.onrender.com/api/mcp" } } }
```

## What stays where

- **Nothing PayPal returns goes to Claude or any other third party.** Claude reads CPSC's public text and the shop's own item titles. Sales join to those items in the app, by order number, SKU or exact title. Tests plant PayPal values in the database and check they are in no request Claude would receive. They stop at the wire: they read what the SDK would send, and make no network call.
- **Built to follow PayPal's 48-hour deletion rule.** PayPal-sourced rows are purged hourly at 46 hours, and a test fails if a PayPal-sourced table isn't on that list.
- **The app never emails anyone.** Messages open in the shop's own mail.
- **A shop's buyer emails are encrypted**, and a file is deleted on request or after 7 days.

## Limits

- A shop is checked when a recall first appears. Later edits to that recall don't re-run it.
- Shops are checked against CPSC recalls from 2022 on. The queue says the real number and dates it checked, and names any year that didn't load.
- The matcher reads words. It can't see a label on a real product, so a look-alike can still reach a seller as a card to review.
- `/eval`'s labels were written by Claude and aren't independent. The page says so.
- Sandbox PayPal only. A real shop's file has no PayPal link, so it can't refund.
- The store address on `/check` reads Shopify's public `/products.json` only, so it sees what's listed today and no sales. Its results say "need a check". A listing can't confirm a recall.
- Tested on demo data and public listings. No real shop has run it yet.

## How it's built

Next.js (App Router) and TypeScript, Postgres on Neon, hosted as one Render web service. AG Grid Community for the queue and Recall Replay. `claude-sonnet-5-5` with `claude-haiku-5-5` as its fallback, through the Anthropic SDK. `@paypal/agent-toolkit` for the refund. Vitest for unit and database tests (Postgres runs in-process through PGlite), Playwright for the golden path on the deployed site.

The one background job (`instrumentation.ts`) asks CPSC for recalls every 15 minutes. It touches the database only when the answer changes or on the hourly heartbeat, because a query every 15 minutes would keep a free-tier database awake around the clock.

## Run it locally

Requirements: Node 22.12 or newer, pnpm 10, and a Postgres database.

```bash
pnpm install
cp .env.example .env.local     # then fill in sandbox values
pnpm db:migrate                # apply db/migrations to DATABASE_URL
pnpm load:recalls 2022 2023 2024 2025 2026
pnpm dev                       # http://localhost:3000
```

`.env.example` lists every variable and what reads it. Secrets stay in macOS Keychain or the host's secret store, never in the repo.

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # what CI runs, with a gitleaks scan of the full history
pnpm eval                                                # recomputes eval/results.json
pnpm test:golden                                         # the golden path on the deployed site. It makes real sandbox payments and one real sandbox refund
```

`e2e/measure/` holds specs run on purpose on a deployment: the Claude check, a sale reaching the queue, a shop's own file, and a stored shop getting a new recall.

## Deploy

`render.yaml` defines the service. Migrations run during the build, a deploy waits for CI on its commit, and Render's health check uses `/api/live`. Past recall years load on the first tick after a deploy and retry hourly.

### Maintainer checklist

- [ ] **At the hackathon deadline, 2026-11-12T20:00Z:** turn auto-deploy OFF for `recall-reach-web-e022` in the Render dashboard (and pause the Blueprint's auto-sync), and leave both off until winners are announced.

## Credits

- PayPal webhook signature verification is adapted from [paypaldev/video-bytemonkio-paypal-tutorial](https://github.com/paypaldev/video-bytemonkio-paypal-tutorial) (MIT License, Copyright (c) 2026 ByteMonk LLC).
- Recall data comes from the U.S. Consumer Product Safety Commission's public Recalls API. Recall Reach isn't affiliated with or endorsed by CPSC or PayPal.

## License

MIT. See [LICENSE](LICENSE).
