# Where each number comes from

Numbers in the write-up and on the site, each with the run or dated source behind it, so it can be checked without asking us. A number that isn't listed here has no committed record yet. CPSC's numbers change as recalls arrive. Everything here is sandbox unless it says otherwise.

## Recall Replay

Run `94124fd5-1049-4546-929b-b25b086c66b3`, made Nov 6, 2026, 12:38 PM ET. A saved copy is in [`docs/replay/index.html`](replay/index.html). To check: open [`/replay`](https://recall-reach-web-e022.onrender.com/replay) and press its recount, which works the counts out again from the stored rows.

| Number | What it is |
|---|---|
| 934 | CPSC recalls from 2025 on, run against one demo shop's sales |
| 3 | Matched |
| 18 | Can't tell yet |
| 11 | Came near and were cleared |
| 902 | Nothing near |

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
| About 3 minutes | On the deployed site (build 04ed5dc), a sandbox buyer filed a dispute on an 18.00 USD sale at 9:11 PM ET. PayPal's Disputes API listed it, and held the payment for the buyer's complaint, by 9:14 PM. Review refund then answered "PayPal shows a dispute on this payment. Check it in PayPal first." The database showed 0 approvals and 0 refunds for that demo shop, and PayPal still showed the payment held, with no refund. `server/paypal/refunds.test.ts` pins the message | Nov 9, 2026 |

## Rules this app holds to

| Number | What it is | Where it's enforced |
|---|---|---|
| 180 days | A refund is offered only within this long of the payment | `server/paypal/refunds.ts` |
| 48 hours | PayPal-sourced rows are gone by then. They're purged hourly at 46 | `server/privacy/retention.ts` |
| 7 days | A shop's own file is deleted by then, or sooner if asked | `server/import/ownFile.ts` |

## Outside sources

Each one says only what's quoted or stated here.

| What we say | Source | Dated |
|---|---|---|
| Danny Keysar was 16 months old when he died in a portable crib. It had been recalled five years earlier. The person who bought it never heard. | [Philadelphia Inquirer](https://www.inquirer.com/philly/business/20100711_Consumer_10_0__A_toddler_s_legacy__Grief_and_a_movement_for_better_crib_safety.html), [CPSC's recall page](https://www.cpsc.gov/Recalls/1993/playskool-travel-lite-portable-cribs-recalled-by-kolcraft-suffocation-risk-cited) | Jul 11, 2010; Mar 10, 1993 |
| A federal law requires registration cards on new baby gear | [16 CFR part 1130](https://www.ecfr.gov/current/title-16/chapter-II/subchapter-B/part-1130) | Read Nov 2026 |
| "A recall depends on reaching the original purchaser. Once a product moves into the secondhand market, that connection is lost." The head of the Baby Safety Alliance | [Consumer Reports](https://www.consumerreports.org/babies-kids/child-safety/recalled-inclined-infant-sleepers-still-causing-infant-death-a6165343859) | Apr 2026 |
| "I would be devastated if I sold something and it hurt someone." A kids' resale owner | [Philadelphia Inquirer](https://www.inquirer.com/philly/business/personal_finance/092409_after_market_recalls.html) | 2009 |
| "once you walk out of a store with a purchase you are on your own to follow up and find out if an item has been later recalled." A nonprofit thrift operator | [Community Closet](https://www.communitycloset.org/single-post/2019/01/09/unsafe-and-in-our-town) | Jan 9, 2019 |
| 424 recalls in 2025, and 506 in 2026 through October. The three-person office small businesses could call has been eliminated | [Consumer Reports](https://www.consumerreports.org/product-safety/dangerous-products-cpsc-cuts-a1128194170/) | Nov 5, 2026 |
| "It is illegal to sell any recalled product" | [CPSC's Resellers Guide, Publication 254](https://www.cpsc.gov/s3fs-public/254_ResellersGuide_2-5-25.pdf) | Feb 2025 |
| "In resale, the rule is simple. Car seats should never be resold. Period." And its Hard Line List, "items that should never be taken in resale, recalled or not". `/check` quotes it when these words are typed | [NARTS, Product Safety & Recalls](https://www.narts.org/product-safety-in-resale) | Read Nov 7, 2026 |
| CPSC's Spanish site, and its phone number 800-638-2772 | [cpsc.gov/es](https://www.cpsc.gov/es), in its footer | Read Nov 7, 2026 |
| 18,640 used merchandise stores in 2021, and NARTS's more than 25,000 resale, consignment and nonprofit resale shops. Neither counts only kids' shops | [Census Bureau](https://www.census.gov/newsroom/stories/thrift-store-day.html) | Aug 17, 2023 |
| 44.5%: CPSC's recall response rate for all consumer product recalls in fiscal year 2025, key measure 2025KM2.3.1, against a 43% target. The report's text gives it as 44.55% | [CPSC FY 2025 Agency Performance Report](https://www.cpsc.gov/s3fs-public/FY25-APR.pdf) | Apr 2026 |
| CPSC visited 301 randomly selected thrift stores across the country, and 69 percent had at least one hazardous product. Field work ran from May through September 1999 | [CPSC Study of Hazardous Products in Thrift Stores](https://www.cpsc.gov/Media/Documents/Research--Statistics/Technical-Reports/General-Information/Other-Technical-Reports-/CPSC-Study-of-Hazardous-Products-in-Thrift-Stores) | 1999 study, read Nov 10, 2026 |
| About 37% of cribs and 27% of strollers are handed down or bought secondhand, a 2010 estimate. Recalls of 32 cribs and strollers reached a 15% correction rate, 20% adjusted | [CPSC staff report to Congress](https://www.cpsc.gov/s3fs-public/pdfs/blk_pdf_ReporttoCongressPursuantSection104%28e%29RecallNotificationEffectiveness.pdf) | Mar 30, 2012 |
