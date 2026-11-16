# P5 设计与验收：报告与集成

## 问题

1. `report-html` 只有 verdict/证据/语言视图，judge、flaky、业务覆盖、mutation 都不在上面，决策者仍需翻 JSON。
2. `coverage` 只有通用标签维度，看不出"哪条业务不变量没被用例引用"。
3. 与 craft 主仓的边界只散落在 README 段落里，没有成文契约。

## 设计

### `coverage` 增加业务维度

继续输出通用维度，并新增：

| 字段 | 含义 |
|---|---|
| `by_business_invariant` | 每条不变量的 `{ positive: n, negative: n, covered: boolean }` |
| `by_business_transition` | 每条迁移的 `{ cases: n, covered: boolean }` |
| `by_business_rule` | 每条规则的 `{ boundaries: [{ value, cases: n }], covered: boolean }` |

`gaps` 追加未覆盖条目（例如 `inv-1: no negative case`），与 `audit` 的 `business_*` findings 口径一致。

### HTML 报告增强

新增区块（顺序固定）：

1. 概要：verdict 计数、`not_applicable`、flaky 数、mutation 分数（若同目录存在 mutation 报告）。
2. `by_language` 表。
3. `by_judge` 表 + 分歧用例。
4. flaky 列表。
5. 业务覆盖矩阵（复用 `coverageSuites` 输出）。
6. 每 case 折叠（现有）。

所有区块在数据缺失时显示 "not measured"，不隐藏。

### 与 craft 主仓的边界文档

`docs/ownership-boundary.md`（已建）作为唯一权威；README 只链接不重复。

### 运行手册

`docs/runbook.md`（已建）覆盖：前置检查、跑测、看结论、比较、重打分、judge、mutation、常见失败、证据位置。

## 验收清单

- [x] `coverage` 三类 `by_business_*` 与 `gaps`。
- [x] `report-html` 六个区块；缺数据时显示 `not measured`。
- [x] HTML 转义：case id / 证据中的 `<` `>` `&` 不破坏页面。
- [x] README 的评测方法章节链接到三份文档（roadmap / ownership / runbook）。
- [x] 测试：业务维度 0/部分/全覆盖；HTML 区块存在性与转义。

## 非目标

- 不做在线仪表盘、不加前端框架；输出是单个静态 HTML。

## 真实运行记录

- 真实模型 judge 端到端 run 的 HTML 报告（`.scratch/real-model-run/report.html`）含 verdict、by_language、by_judge、flaky、业务覆盖、Comparison 与 Mutation 区块，无数据时显示 `not measured`。
- HTML 工件可由 `--comparison` / `--mutation` 注入：`compare --output` 与 `mutation` 分别落盘 JSON；`tests/report-integration.test.ts` 验证工件并入了页面，并验证 HTML 转义。

