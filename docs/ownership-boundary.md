# 职责边界：craft-eval 与 craft 主仓

仓库里同时存在两套评测代码，必须明确谁负责什么，避免口径分叉导致"同一个结论两个数字"。

## 一句话边界

- **craft-eval（本仓库）**：固定版本 + 执行 + 产出 JSON 证据。它不决定是否上线。
- **craft 主仓**：消费证据、做决策、调度发布/Canary/路由。它不重新发明判分器。

## 对照表

| 事项 | craft-eval | craft 主仓 |
|---|---|---|
| 定义 Suite / Case / Runtime 合同 | 拥有 | 可读取，不另立格式 |
| 执行被测对象（argv / Host / MCP / driver） | 拥有 | 通过 `runEvaluationProcess` 调用 |
| 确定性检查与判分 | 拥有 | 不重复实现 |
| 模型判断（`model_graded`） | 提供接口，judge 由外部命令提供 | 提供 judge 命令/网关 |
| 统计与增益门控 | 拥有（符号检验、Bootstrap、`skill_gain_supported`） | 可消费，不自行放宽门控 |
| 审计（污染、留出集、业务模型覆盖） | 拥有 | 以 audit 结果作为进入下一阶段的必要条件 |
| 归因（失败分类、flaky） | 拥有 | 消费归因结果做分派 |
| 决策：是否上线 / 发布 / 路由 | **不拥有** | 拥有 |
| 事故回流为回归用例 | 提供 Case 合同 | 拥有流程与责任人 |

## 已知的两处并存实现

1. `craft-eval/src/evaluation.ts` —— 受控执行器，产出 `plan.json` + `results/*.json`。
2. `craft/core/evaluation.ts` 与 `craft/capability/craft-eval/suite.ts` —— 主仓内置评测（三账本：capability / safety / value）。

两者**语义不同，不可互相替代**：

- 本仓库的 comparison 以"配对用例 verdict"为单位，输出风险差、符号检验 `p`、`judge_agreements`。
- 主仓三账本以能力/安全/价值三条独立账为单位，输出各账本分数与 `quotable` 判定。

## 禁止事项

- 禁止在任一仓库**复制**对方的判分逻辑（例如在本仓库实现三账本评分，或在主仓复制 `model_graded` 的超时/输出上限语义）。
- 禁止把本仓库的 `skill_gain_supported` 改写成"允许发布"；它只表示"这组任务上的证据支持改善"。
- 禁止用 `mutation_score` 或 `coverage` 直接触发发布；它们只用于说明"用例盲区"。

## 集成建议

1. 主仓通过 `craft-eval run` 的子进程输出（或 `craft-eval/run` 导出函数）取得 `run_dir`。
2. 主仓读取 `plan.json` 中的 `execution_controls` 与 `subject.digest` 做可比较性判断，**不自行推断**。
3. 主仓的三账本结论必须引用本仓库 run 的 `run_id`，形成可追溯链。
4. 任何一方修改判分语义（例如 `threshold` 默认值、`judge_error` 是否算失败），必须同步更新本文与 `README.md`。

## 变更流程

1. 修改合同字段 → 更新 `README.md` 合同章节与本文件对照表。
2. 修改判分语义 → 增加回归测试 + 在 `docs/roadmap-to-ideal-state.md` 对应阶段记录验收证据。
3. 删除/重命名导出 → 检查 `package.json` 的 `exports` 与主仓调用点。
