# P1 设计与验收：多 judge 聚合

## 问题

一个业务用例通常需要多个判分视角（合规、转化、可读性）。现在 `Check.judge` 只做标签，没有聚合语义，也没有分歧报告：两个 judge 一个过、一个不过时，用例结论由 `Case.threshold` 的加权通过率决定，读者无法知道"是哪个 judge 反对"。

## 设计

### 合同

```json
{
  "id": "pdp-compliance",
  "judge_policy": { "mode": "all_required" },
  "checks": [
    { "id": "compliance", "kind": "model_graded", "judge": "compliance", "command": ["node","judge-compliance.mjs"], "answer": "outputs/answer.md", "threshold": 0.9 },
    { "id": "conversion",  "kind": "model_graded", "judge": "conversion",  "command": ["node","judge-conversion.mjs"],  "answer": "outputs/answer.md", "threshold": 0.6 },
    { "id": "readability", "kind": "model_graded", "judge": "readability", "command": ["node","judge-readability.mjs"], "answer": "outputs/answer.md", "threshold": 0.6 }
  ]
}
```

`judge_policy.mode`：

| mode | 语义 | 失败条件 |
|---|---|---|
| `all_required` | 每个 judge 组都必须通过 | 任一 judge 组 failed |
| `any` | 至少一个 judge 组通过 | 全部 judge 组 failed |
| `weighted` | 按 judge 权重加权得分 ≥ `min_score` | 总分 < `min_score` |

约束：

- `judge_policy` 只作用于**带 `judge` 字段的 checks**；不带 judge 的确定性检查仍按 `threshold` 原有语义处理。
- `judge_policy` 与 `Case.threshold` 同时出现时，`threshold` 只算确定性检查，judge 组另算；两者都通过才算 passed。
- 任一 judge 报 `judge_error` → 该组 `inconclusive` → 用例 `inconclusive`（`all_required` 下也不降级为 failed）。
- 未声明 `judge_policy` 但存在多个 judge 时，默认 `all_required`，并在 `report` 里输出提示 `judge_policy_defaulted`。

### 报告

`report` 新增：

```json
{
  "by_judge": {
    "compliance": { "observed": 12, "passed": 11, "failed": 1, "inconclusive": 0, "cases": ["pdp-compliance#1"] },
    "conversion": { "observed": 12, "passed": 12, "failed": 0, "inconclusive": 0, "cases": [] }
  },
  "judge_disagreements": [
    { "case_id": "pdp-compliance", "trial": 1, "passing_judges": ["conversion"], "failing_judges": ["compliance"] }
  ]
}
```

`compare` 新增 `judge_agreements`：

```json
[{ "judge": "compliance", "agreement": 0.83, "cases": 12 }]
```

`agreement` = 同一 (case, trial) 在 baseline 与 candidate 下该 judge 的 verdict 相同比例；`null` 表示该 judge 没有可比样本。

`analyze` 新增分类 `judge_disagreement`：同一用例内 judge 组 verdict 不一致时归入此类，`evidence` 给出 pass/fail judge 名单。

## 验收清单

- [x] `judge_policy` 三种 mode 的校验与执行（含 `weighted.min_score` 边界 0/1）。
- [x] `report.by_judge` 与 `judge_disagreements` 字段。
- [x] `compare.judge_agreements` 实际计算（不是仅有类型）。
- [x] `analyze` 的 `judge_disagreement` 分类。
- [x] 测试：三 mode ×（全一致 / 部分分歧 / 全分歧）×（judge 报错），共 ≥12 个用例。
- [x] 示例：`examples/gated-output/` 增加多 judge 版本。

## 真实运行记录

- `examples/gated-output/suite-multi-judge.json`：3 用例 × 2 judge（accuracy / brand），`all_required` 与 `any` 两种策略。
- 离线 judge 资产 `examples/gated-output/judge.mjs` 写到 stdout，命令用 `{{craft-eval}}` 锚点定位，避免复制进被测工作区。
- 实测：passed 2 / failed 1 / inconclusive 0；`report.by_judge` 分别列出两个 judge 的通过/失败，`judge_disagreements` 抓到 `split-verdict-any-passthrough` 上 brand 通过、accuracy 失败的分歧。

## 非目标

- 不实现自动权重学习；权重必须显式声明。
- 不把 judge 分数与确定性检查分数混算。
