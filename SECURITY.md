# Security

## Reporting a problem

Please report a security problem privately, through GitHub's private vulnerability reporting: on this repository's Security tab, press **Report a vulnerability**. Please don't open a public issue for it.

## Who can move money

A refund needs the shop owner to review it and confirm its exact amount, for a sale after the recall date and inside 180 days. Only the app's own server code calls the refund, never Claude. None of the tools our own code offers Claude has a field for an amount, currency, capture, refund or payee, and [a test](server/agent/moneyFields.test.ts) fails if one does. On /studio, any of AG Studio's own tools that names money is dropped before Claude sees it, and the same test checks that. The answer format AG Studio asks for is passed on as it is, and Claude's answer in it goes back to the page as text. More in the README: [Who can move money](README.md#who-can-move-money).

## Attacks tried against the code

[/safety](https://recall-reach-web-e022.onrender.com/safety) tries five things that must be refused, through the real code on throwaway shops that are deleted afterwards:

1. A listing whose title gives orders.
2. A forged PayPal webhook.
3. A refund sent twice.
4. A refund past PayPal's 180 days.
5. The same brand, another product.

PayPal and the model are stand-ins there, so a run never moves sandbox money. Each outcome is read from what really happened, and a check that can't run says so.

## What stays where

- Nothing PayPal returns goes to Claude or Channel3. Tests plant PayPal values in the database and check they are in no request Claude would receive, and in none of the market searches the recall sweep sends to Channel3.
- Built to follow PayPal's 48-hour deletion rule: PayPal-sourced rows are purged hourly at 46 hours, and a test fails if a PayPal-sourced table isn't on that list.
- The app never emails anyone. Messages open in the shop's own mail.

More in the README: [What stays where](README.md#what-stays-where).

## Secret scanning

Every CI run scans the full git history with gitleaks and fails on a finding (the "gitleaks (full history)" job in [.github/workflows/ci.yml](.github/workflows/ci.yml)).
