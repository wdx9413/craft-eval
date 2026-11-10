# Changelog

## 0.7.0

- Preserve bounded partial-reason codes and Codebase omission counts in Context Audit reports.
- Missing or contradictory partial diagnostics remain inconclusive or fail consistency checks; source material is never copied into the report.
- Keep report evaluation deterministic and do not treat diagnosability as proof of Context usefulness.

## 0.6.0

- Detect response-level omissions in Craft Context receipts and return inconclusive rather than passing an incomplete response.
- Validate omission metadata consistency and report omitted item counts without exposing content.
- Add complete branch, line, and function coverage for the Context Audit contract.

## 0.5.0

- Add release-critical checks for Craft npm/runtime artifact alignment and Workbench desktop sidecar preparation.
- Keep Hook diagnostics coverage cases tied to the installed package versions under evaluation.
- These local deterministic checks do not establish rendered UI quality, Host timeout attribution, or user task benefit.


## 0.4.0

- Add strict Craft Hook diagnostic coverage and authenticated Workbench API cases to the Craft project suite.
- Add on-demand Workbench Hook diagnostics coverage to the installed runtime quality suite.
- Fix suite coverage assertions to match the actual coverage reporters and their output stream.
- These local deterministic checks do not establish rendered UI quality, Host timeout attribution, or user task benefit.

## 0.3.0

- Add an explicit localhost-bind requirement so cases that need local servers report `not_applicable` when the evaluator cannot bind loopback.
- Cache the capability probe per process and cover success, bind failure, and close failure deterministically.
- Fix the Craft-Eval regression suite generator: Node 23 `--test-isolation=none` disabled reliable name filtering and made self-evaluation fail; generated cases now run one selected test.
- Add deterministic regression coverage for the loopback probe and generated command contract.

## 0.2.0

- Add `context-audit` for deterministic checks of saved Craft Context MCP receipts against held-out reference and budget labels.
- Report selected-reference coverage, false-positive references, duplicate references, item/character/token budgets, reference-only material checks, partial status, and input digests without echoing asset text.
- Return `inconclusive` for partial receipts or missing required Host token measurements; this check does not claim task benefit.
