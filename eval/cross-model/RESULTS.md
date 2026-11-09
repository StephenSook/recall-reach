# Blind cross-model label audit, 2026-11-09 12:57 EST

NOT a human audit. A second model family checked Claude's eval labels blind. "No person has audited them yet" stays true until a person does.

- Auditor: OpenAI's gpt-6.1-sol via the Codex CLI v0.163.0 (codex exec, read-only sandbox, reasoning effort high, no browsing; model name read from the run log header). It saw blind-pairs.json: recall title, recalled products and models, the first 600 characters of the description, and the listing title. It never saw Claude's labels, and the script asserts that no label appears in that file.
- Where it ran: Codex started in a folder that also held sample.json with Claude's labels (`codex exec -C . -s read-only`), so the sandbox could have read them. Its run log lists every command it ran: two, both reading only cross-model/blind-pairs.json (`head -c 100000` and a Python count of the pairs). It never opened sample.json or any other file. The log isn't in this repo because it holds local paths.
- Sample: the same 50 held-out pairs as the human audit (seed 20261108, stratified 36 NEAR_MISS / 8 NO_MATCH / 6 UNSURE from 95).
- Scorer: score_audit.py, unchanged. It prints "Stephen" as the answerer because it was written for a human audit; here the answers are gpt-6.1-sol's. server/eval/crossModel.test.ts re-scores them on every CI run.
- Result (MEASURED): agreement 34 of 50 (68%, Wilson 95% 54 to 79%). NEAR_MISS 20 of 36, NO_MATCH 8 of 8, UNSURE 6 of 6.
- All 16 disagreements are Claude "look-alike" against gpt-6.1-sol "the title can't settle it". gpt-6.1-sol called none of Claude's look-alikes the recalled product (0 of 44), so nothing here would raise the published "could reach a family 2 times in 83".
- Files: blind-pairs.json (input), PROMPT.md, codex-answers.raw (output as returned), codex-answers.json (parsed).

Safe public sentence: "A second model (gpt-6.1-sol), blind to Claude's labels, agreed on 34 of 50 sampled pairs. On the other 16 it said the title can't settle it, and it called none of Claude's look-alikes the recalled product."
