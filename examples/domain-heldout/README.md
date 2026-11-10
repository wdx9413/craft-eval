# Domain held-out suites (coding / quant / writing)

Three frozen, deterministic held-out suites that grade **whether a domain
candidate clears its own domain gate**, using `craft-eval`'s real `run` path.
They are the效果验证 companion to Craft's `domain_isolation` mechanism tests.

## What is actually graded

Each suite has one case: a stand-in `runner.mjs` emits `outputs/result.json`,
and a `grade.mjs` script check applies domain-specific deterministic rules.

| Domain | Frozen gate | Rejects |
| --- | --- | --- |
| `coding` | all tests pass, line coverage ≥ 0.9, zero regressions | a failing test, low coverage, or a regression |
| `quant` | positive out-of-sample net return, drawdown ≤ 0.2, ≥ 20 trades | negative return, oversized drawdown, in-sample, too few trades |
| `writing` | clarity / factual_accuracy / style_consistency ≥ 0.8, zero forbidden claims, audience matched | a low rubric dimension, forbidden claims, or audience mismatch |

All three suites are `partition: "held_out"`, `sanitized: true`, with an
independent `approved_by`, a primary metric + guardrail, and per-case
`expected_behavior` / `provenance` (`independent_of_training: true`,
`reviewed_by`). `craft-eval audit` reports `passed` with zero findings for all
three. The numbers are fixed so a run is reproducible; a
real subject would compute them from its own test suite / out-of-sample price
panel / calibrated judge instead of emitting a fixture.

## Honest boundary

This grades the **domain gate mechanism**, not model quality. `all green` means
"the evaluator correctly accepts a compliant record and its graders are not
tautologies" — it does **not** claim a model is good at coding, quant, or
writing. `verify-graders.mjs` is the anti-tautology check: for every domain it
feeds a degraded record and asserts the grader exits 1. An uncalibrated LLM
judge must not be used to promote a candidate (Craft's frozen-Subject rule).

## Running

```bash
cd craft-eval
npm run build
node examples/domain-heldout/run-all.mjs
```

`run-all.mjs` runs the three suites through `dist/src/cli.js run ...
--fail-on-failed`, asserts each report is `complete` with `passed=1` and no
failed/inconclusive cases, then runs `verify-graders.mjs`. It exits non-zero on
any failure. `verify-graders.mjs` can also be run alone; it needs no build.

To wire a real domain subject in, replace `runner.mjs` (keep the emitted record
shape) and, when a domain's notion of "good" changes, version both `grade.mjs`
and `suite.json` together — an edited grader with the same suite id would make
the held-out digest stale, which Craft's comparison gate rejects.
