# Changelog

## 0.2.0

- Add `context-audit` for deterministic checks of saved Craft Context MCP receipts against held-out reference and budget labels.
- Report selected-reference coverage, false-positive references, duplicate references, item/character/token budgets, reference-only material checks, partial status, and input digests without echoing asset text.
- Return `inconclusive` for partial receipts or missing required Host token measurements; this check does not claim task benefit.
