You are auditing a product-recall matcher's evaluation labels, blind. Read cross-model/blind-pairs.json in this folder. For each of the 50 pairs, read the CPSC recall (title, recalled products with any model numbers, description) and the listing title, and answer one question: "Is this listing the recalled product?"
Answer with exactly one of:
- MATCH: yes, the listing is the recalled product (same product and maker, and nothing in the title rules out the recalled models or units).
- LOOKALIKE: no, it's a look-alike or a different product (a different product type, maker, or model the recall doesn't cover).
- UNSURE: the title alone can't settle it (for example the right kind of product and maker, but the recall depends on a model number, date code or unit detail the title doesn't give).
Judge from the text given only; do not browse. Do not guess at hidden labels. Output ONLY a JSON object, no prose, in exactly this form:
{"seed": 20261108, "answers": {"<pair_id>": "MATCH|LOOKALIKE|UNSURE", ...}}
with all 50 pair_ids.
