#!/usr/bin/env python3
"""Score Stephen's label audit: agreement between his answers and Claude's labels, with a Wilson 95% interval.
Usage: score_audit.py <label-audit-answers.json>. Claude's NEAR_MISS and NO_MATCH both mean "a look-alike"
(app/eval/wrongPairs.ts:19), so both map to LOOKALIKE. Refuses to score an incomplete or mismatched file.
"""
import json, math, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sample = json.loads((HERE / "sample.json").read_text())
ans = json.loads(Path(sys.argv[1]).read_text())
if ans.get("seed") != sample["seed"]:
    raise SystemExit(f"seed mismatch: answers {ans.get('seed')} vs sample {sample['seed']}")
MAP = {"NEAR_MISS": "LOOKALIKE", "NO_MATCH": "LOOKALIKE", "UNSURE": "UNSURE", "MATCH": "MATCH"}
pairs = sample["pairs"]
missing = [p["pair_id"] for p in pairs if p["pair_id"] not in ans["answers"]]
if missing:
    raise SystemExit(f"{len(missing)} of {len(pairs)} unanswered: {missing[:10]}")


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0, c - h), min(1, c + h)


agree = [p for p in pairs if ans["answers"][p["pair_id"]] == MAP[p["label"]]]
k, n = len(agree), len(pairs)
lo, hi = wilson(k, n)
print(f"Agreement: {k} of {n} ({100 * k / n:.0f}%, Wilson 95% {100 * lo:.0f} to {100 * hi:.0f}%)")
for lab in ("NEAR_MISS", "NO_MATCH", "UNSURE"):
    sub = [p for p in pairs if p["label"] == lab]
    a = sum(1 for p in sub if ans["answers"][p["pair_id"]] == MAP[lab])
    print(f"  Claude said {lab}: {a} of {len(sub)} agreed")
print("Disagreements:")
for p in pairs:
    if ans["answers"][p["pair_id"]] != MAP[p["label"]]:
        print(f"  {p['pair_id']}: Claude {p['label']}, Stephen {ans['answers'][p['pair_id']]}: {p['listing_title']}")
worst = [p for p in pairs if p["label"] in ("NEAR_MISS", "NO_MATCH") and ans["answers"][p["pair_id"]] == "MATCH"]
print(f"Look-alikes Stephen says ARE the recalled product: {len(worst)} (these would change the published numbers)")
