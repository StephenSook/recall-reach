# Identifier search: 292 of 934

Our identifier search found no model number or code in 292 of 934 CPSC API records (recall dates 2025-01-02 to 2026-11-05). This is the output of a regex rule, not proof that those records contain no identifier.

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

Its columns are copied from the API record: `RecallNumber`, `RecallDate` (the date part), `Description`, `ProductUPCs` (the UPC values) and `ProductModels` (each product's Model, where filled). Multiple values are joined with ` | `. Nine email addresses in two descriptions (recalls 25280 and 25286) are replaced with `[email]`, and two business addresses copied from product labels (recalls 25231 and 25337) with `[address]`. The count is the same with or without them. Nothing in it comes from a shop, an order or PayPal.

## The rule

A record has an identifier if any of these holds:

- its `ProductUPCs` has a value (28 of the 934 do),
- one of its products has a `Model` value (none of the 934 do),
- its `Description` has (a) an upper-case token with a digit and a letter, 4 or more characters, that isn't a unit such as "20V", or (b) an identifier word (model, item, style, SKU, part, catalog, serial, lot, batch, UPC, date code, product code, reference, FCC ID, RN, ASIN) followed within 30 characters, before the next period and space, by a token of 2 or more characters with a digit (not a bare year) or an upper-case dashed code such as `BBL-MM-LAMP`.

## How far to trust it

An AI review read 20 of the 292, drawn at random with seed 20261106: 27051, 26540, 27026, 26297, 26498, 25477, 26296, 26775, 25468, 26397, 25281, 26207, 26138, 26158, 25106, 26788, 26726, 26005, 25382 and 25202. In 2, it found an identifier the rule missed: 27051 names letter-only model series (FTVN, TFTN, EFTU), and 26788 says "Prototype ID: PU-US". It judged the other 18 to have none, but one of them, 26138, names bike models such as "Domane+ ALR 5", so a stricter reading counts 3 misses. The same review read 20 records the rule says have one. In 2, the only token it found was a size: "CR2032" in 26484 is a battery size, and "4-5T" in 27045 is a clothing size. So the rule misses in both directions. No person has audited either sample. Some recalls keep their model lists on the cpsc.gov page rather than in the API text, so a record here can still have identifiers on CPSC's site.
