# Changelog

## 0.3.0

- Add an explicit localhost-bind requirement so cases that need local servers report `not_applicable` when the evaluator cannot bind loopback.
- Cache the capability probe per process and cover success, bind failure, and close failure deterministically.
- Fix the Craft-Eval regression suite generator: Node 23 `--test-isolation=none` disabled reliable name filtering and made self-evaluation fail; generated cases now run one selected test.
- Add deterministic regression coverage for the loopback probe and generated command contract.

## 0.2.0

- Add `context-audit` for deterministic checks of saved Craft Context MCP receipts against held-out reference and budget labels.
- Report selected-reference coverage, false-positive references, duplicate references, item/character/token budgets, reference-only material checks, partial status, and input digests without echoing asset text.
- Return `inconclusive` for partial receipts or missing required Host token measurements; this check does not claim task benefit.
