# Where each number comes from

Every number in the film and the write-up, with the run or dated source behind it, so it can be checked without asking us. CPSC's numbers change as recalls arrive. Everything here is sandbox unless it says otherwise.

## Recall Replay

Run `94124fd5-1049-4546-929b-b25b086c66b3`, made Nov 6, 2026, 12:38 PM ET. A saved copy is in [`docs/replay/index.html`](replay/index.html). To check: open [`/replay`](https://recall-reach-web-e022.onrender.com/replay) and press its recount, which works the counts out again from the stored rows.

| Number | What it is |
|---|---|
| 934 | CPSC recalls from 2025 on, run against one demo shop's sales |
| 3 | Matched |
| 18 | Can't tell yet |
| 11 | Came near and were cleared |
| 902 | Nothing near |

The filmed run: to be filled in at the take.

## Recalls held

| Number | What it is | How to check |
|---|---|---|
| 1,855 | CPSC recalls dated 2022 on, read Nov 7, 2026. It grows as CPSC publishes | `checked.recalls` from [`/api/check`](https://recall-reach-web-e022.onrender.com/api/check?title=stroller), or the line at the foot of the home page |

## The eval

From [`eval/results.json`](../eval/results.json), made by `pnpm eval` from [`eval/pairs.csv`](../eval/pairs.csv) and [`eval/recalls.json`](../eval/recalls.json) through the real matcher. A test fails if the committed results stop matching what the code produces. Shown with their intervals on [`/eval`](https://recall-reach-web-e022.onrender.com/eval). The pairs were labelled for this project, so these describe this set, not every shop.

| Number | What it is | Field |
|---|---|---|
| 2 of 83 | Held-out pairs that aren't the recalled product, where a seller could message a family | `heldOut.matcher.couldReachFamily` |
| 37 of 83 | The same pairs raised to a person to look at | `heldOut.matcher.falseAlarms` |
| 45 of 83 | The same pairs, with a word-match baseline | `heldOut.baseline.falseAlarms` |
| 11 of 12 | Pairs CPSC's text can't settle, where it asked instead of guessing | `heldOut.matcher.abstained` |
| 52 of 60 | Recalls whose stated model it confirmed. The other 8 ask | `statedModels.matcher.confirmed` |

## Measured on the sandbox

One read each unless it says otherwise, so they show what happened, not what always happens. The README's "What the real sandbox did" has the detail.

| Number | What it is | Read on |
|---|---|---|
| 6.11 hours | A repeat of the same request id still returned the first refund, and the total refunded didn't move | Nov 6, 2026 |
| 213 minutes | A new sale wasn't in Transaction Search at first, and was there this long after | Nov 5, 2026 |

## Rules this app holds to

| Number | What it is | Where it's enforced |
|---|---|---|
| 180 days | A refund is offered only within this long of the payment | `server/paypal/refunds.ts` |
| 48 hours | PayPal-sourced rows are gone by then. They're purged hourly at 46 | `server/privacy/retention.ts` |
| 7 days | A shop's own file is deleted by then, or sooner if asked | `server/import/ownFile.ts` |

## Outside sources

To be filled in with each one's publisher, date and link before the repository goes public.

## The film

To be filled in at the take: each number on screen, and the run it came from.
