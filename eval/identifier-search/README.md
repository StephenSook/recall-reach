# Identifier search: 292 of 934

Our identifier search found no model number or code in 292 of 934 CPSC API records (recall dates 2025-01-01 to 2026-11-05). This is the output of a regex rule, not proof that those records contain no identifier.

## Run it

```
python3 identifier_search.py records.csv
```

It prints:

```
No model number or code found in 292 of 934 records (RecallDate 2025-01-02 to 2026-11-05).
```

Add `--list` to print the 292 recall numbers. It needs Python 3 and nothing else.

## The data

`records.csv` holds one row per recall, from CPSC's Recalls API (saferproducts.gov RestWebServices/Recall): the 2025 records, and `RecallDateStart=2026-01-01&RecallDateEnd=2026-11-05`, pulled on Nov 5, 2026. The earliest recall date in the range is Jan 2, 2025.

Its columns are copied from the API record: `RecallNumber`, `RecallDate` (the date part), `Description`, `ProductUPCs` (the UPC values) and `ProductModels` (each product's Model, where filled). Multiple values are joined with ` | `. Nine email addresses in two descriptions (recalls 25280 and 25286) are replaced with `[email]`. The count is the same with or without them. Nothing in it comes from a shop, an order or PayPal.

## The rule

A record has an identifier if any of these holds:

- its `ProductUPCs` has a value (28 of the 934 do),
- one of its products has a `Model` value (none of the 934 do),
- its `Description` has (a) an upper-case token with a digit and a letter, 4 or more characters, that isn't a unit such as "20V", or (b) an identifier word (model, item, style, SKU, part, catalog, serial, lot, batch, UPC, date code, product code, reference, FCC ID, RN, ASIN) followed within 30 characters, in the same sentence, by a token with a digit (not a bare year) or an upper-case dashed code such as `BBL-MM-LAMP`.

## How far to trust it

An AI review read 20 of the 292. In 18, the API text had no identifier. In 2, it had one the rule missed: 27051 names letter-only model series (FTVN, TFTN, EFTU), and 26788 says "Prototype ID: PU-US". No person has audited the sample. Some recalls keep their model lists on the cpsc.gov page rather than in the API text, so a record here can still have identifiers on CPSC's site.
