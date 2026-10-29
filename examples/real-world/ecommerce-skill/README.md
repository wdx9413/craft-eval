# ecommerce-skill (vendored evaluation fixture)

`workspace/skills/ecommerce-visual-copywriting/` and `workspace/test-prompts.json`
are copied from
[feichanggege/ecommerce-visual-copywriting-skill](https://github.com/feichanggege/ecommerce-visual-copywriting-skill)
(MIT licensed). They are vendored only as a deterministic evaluation fixture.

The upstream project is not modified. `grade.mjs` and `run.ps1` are craft-eval
side files; `grade.mjs` reads the upstream `test-prompts.json` rules and applies
negation-aware matching so a compliance ledger that quotes forbidden claims is
not counted as a violation.
