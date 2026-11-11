"""Count CPSC recall records with no model number or code that a regex rule can find.

Usage:
    python3 identifier_search.py records.csv          # prints the count
    python3 identifier_search.py records.csv --list   # also lists those recall numbers

A record counts as having an identifier if any of these holds:
    - its ProductUPCs field has a value,
    - one of its Products has a Model value,
    - its Description has an identifier by rule (a) or (b) below.

This is the output of a regex rule, not proof that a record contains no identifier.
"""
from __future__ import annotations

import csv
import re
import sys

# (a) An upper-case token with at least one digit and one letter, 4 or more characters,
# that isn't a unit such as "20V" or "1500W".
TOKEN_RX = re.compile(r"(?<![\w-])(?=[A-Z0-9_./-]*\d)(?=[A-Z0-9_./-]*[A-Z])[A-Z0-9][A-Z0-9_./-]{2,}[A-Z0-9](?![\w-])")
UNIT_TOKEN = re.compile(r"^\d+(?:\.\d+)?(?:V|W|MAH|OZ|FT|IN|MM|CM|ML|L|GB|TB|HZ|LB|LBS|PCS|PC|PK|X|D|K|AH|A|QT|CC|HP|G)$")

# (b) An identifier keyword, followed within 30 characters, before the next period and whitespace, by a
# token of 2 or more characters that has a digit (not a bare year) or is an upper-case dashed code
# such as BBL-MM-LAMP.
ID_KW_RX = re.compile(
    r"\b(model|models|item|style|sku|skus|part|catalog|serial|lot|lots|batch|upc|date codes?|"
    r"product codes?|reference|ref|fcc id|rn|asin)\b\s*(?:numbers?|nos?\.?|#|codes?|ids?)?",
    re.I,
)
ANCHOR_TOKEN_RX = re.compile(r"(?<![\w-])(?:[A-Za-z0-9][A-Za-z0-9_./-]*\d[A-Za-z0-9_./-]*|[A-Z]{2,}(?:-[A-Z0-9]+)+)(?![\w-])")
YEAR_RX = re.compile(r"^(?:19|20)\d{2}$")


def has_token(desc: str) -> bool:
    return any(not UNIT_TOKEN.match(t) for t in TOKEN_RX.findall(desc))


def keyword_anchored(desc: str) -> bool:
    for m in ID_KW_RX.finditer(desc):
        window = re.split(r"\.\s", desc[m.end(): m.end() + 30])[0]
        if any(not YEAR_RX.match(t) for t in ANCHOR_TOKEN_RX.findall(window)):
            return True
    return False


def has_identifier(row: dict) -> bool:
    desc = row["Description"]
    return bool(row["ProductUPCs"].strip()) or bool(row["ProductModels"].strip()) or has_token(desc) or keyword_anchored(desc)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    with open(argv[1], newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        print("No records read.")
        return 1
    none = [r for r in rows if not has_identifier(r)]
    dates = sorted(r["RecallDate"] for r in rows)
    print(f"No model number or code found in {len(none)} of {len(rows)} records (RecallDate {dates[0]} to {dates[-1]}).")
    if "--list" in argv:
        print(" ".join(r["RecallNumber"] for r in none))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
