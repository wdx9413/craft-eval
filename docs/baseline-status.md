# 现状基线（对照路线图）

记录于 `craft-eval@0.7.2`。本文只陈述**代码事实**，不评价价值；用于判断路线图各阶段从哪一步开始。

## 已实现（可直接使用）

| 能力 | 证据（代码位置） |
|---|---|
| 受控执行 + 结果分目录 | `src/evaluation.ts`（`runSuite` / `oneCase` / `plan.json` + `results/*.json`） |
| 九类确定性检查 | `src/evaluation.ts`：`exit_code` `file_exists` `json_equals` `trace_event` `script` `tool_call` `stdout_contains` `stdout_not_contains` `docs_links` |
| 模型判断 check | `src/evaluation.ts`：`model_graded`，外部命令 + `CRAFT_EVAL_JUDGE_ANSWER` / `_RUBRIC`，失败记 `judge_error` |
| judge 校准 | `src/calibration.ts`：`accuracy` / `consistency` / `per_sample`，支持 `--timeout-ms` `--max-output-bytes` |
| 变异测试 | `src/mutation.ts`：`killed` / `survived` / `errored` / `mutation_score`，`subject_env` 支持 `{{copy}}` |
| 环境门控 | `CaseRequirement`：`commands` `env` `python_modules` `paths` `symlink` `network_loopback` → `not_applicable` |
| 业务模型 | `BusinessModel`：`invariants` `transitions` `rules` `incidents`，`audit` 派生检查已覆盖 |
| 审计 | `src/audit.ts`：重复 ID/prompt/acceptance、开发-留出复用、留出集审核与独立性、过期、无信息量、skill 增益门槛、boundaries 未强制、业务模型覆盖 |
| 覆盖矩阵 | `src/audit.ts` `coverageSuites`：`by_category` `by_risk` `by_difficulty` `by_language` `by_check_kind` |
| 统计 | `src/statistics.ts`：符号检验、Bootstrap 95% CI、odds ratio、phi、连续指标摘要 |
| 归因 | `src/attribution.ts`：13 类失败分类 + `external_dependency_missing`、聚类、最慢/最贵 |
| 比较 | `src/evaluation.ts` `compareRuns`（结果目录）+ `src/compare-run-reports.ts`（三账本报告） |
| 离线重打分 | `src/evaluation.ts` `rescoreScripts`：只重跑 `script`，不读 gateway 副本 |
| 证据保留 | `--keep-traces`：stdout/stderr/host-trace/gateway-trace + `outputs/` |
| 进程监督 | `src/command-process.ts` + `src/command-guardian*.ts`：独立监护进程、`signal` 取消、输出上限 |
| HTML 报告 | `src/report-html.ts`：verdict 徽章、case 折叠、check 证据、`by_language` |
| Windows 命令解析 | `src/evaluation.ts` `commandInvocation`：`.cmd/.bat` 经 `cmd.exe`，argv 保持独立 token |
| 实验 / Scenario | `src/experiment.ts`、`src/scenario.ts` |

## 已声明但未计算/执行（路线图输入）

| 项 | 现状 | 归属阶段 |
|---|---|---|
| `Comparison.judge_agreements` | 仅 `src/compare-run-reports.ts:67` 有类型声明，函数体不计算 | P1 |
| 多 judge 聚合策略 | 无 `judge_policy`，`Case.threshold` 只作用于全体 checks | P1 |
| per-judge 报告 | `report` 无 `by_judge` | P1 |
| `judge_disagreement` 归因 | `FailureCategory` 无此类 | P1 |
| flaky 判定 | 多 trial 不统计一致性，`report` 无 `flaky_cases` | P2 |
| `--keep-traces on-failure` | 只支持布尔开关 | P2 |
| 数据集版本链 | `Suite` 无 `version` / `parent_digest`；无 `diff` 命令 | P3 |
| 近似重复检测 | `audit` 只做规范化文本精确相等 | P3 |
| 跨分区同源污染 | 无 `shared_source_cross_partition` | P3 |
| 业务维度覆盖矩阵 | `coverage` 无 `by_business_*` | P5 |
| 金集版本化目录 | 仅有单文件示例 `examples/judge-pool.json`，无版本化目录 | P0 |
| 真实模型 judge 示例 | 仅规则式 stub `examples/judge-workspace/judge.mjs` | P0 |

## 已存在但需补强的示例资产

| 资产 | 位置 | 状态 |
|---|---|---|
| 金集样本 | `examples/judge-pool.json`（10 例，含正/负/边界） | 已建，缺 `provenance` 与版本目录 |
| 规则式 judge | `examples/judge-workspace/judge.mjs` | 已建，仅离线管线验证 |
| model_graded 套件 | `examples/gated-output/suite.json`（5 例） | 已建，缺真实 judge 替换说明 |

## 真实对象评测记录（历史）

| 对象 | 结果 | 说明 |
|---|---|---|
| 电商 Skill（第三方 877★） | 3/3 passed | 任务级评测；Codex 不暴露 `skill.invoked`，触发证据不可得 |
| 金融 MCP（loan-calculator） | 2 passed / 2 failed | 失败为被测项目真实摊销缺陷 |
| 金融 MCP 变异测试 | `mutation_score = 0.67` | 2 个公式缺陷被杀死，1 个 no-op 按预期幸存 |
| 金融 MCP 校准 | `accuracy=1 consistency=1` | 修正 judge 判据后达成 |
| 电商 Agent（单轮） | passed | 应付金额 208 与期望一致 |
| Git 软件 dulwich | passed | `test_object_store.py` 164 通过 |
| quta | 2/2 passed | 全量 pytest + 文档链接 |
| craft 主仓（官方全量） | 3509 tests / 3220 pass / 275 fail | 失败主因：248 处 symlink EPERM（环境）、28 处 SQLite（疑似跨用例污染）、5 处 JDK 缺失 |

## 未验证风险

1. Codex 模式无法产出 `skill.invoked`，skill 触发级增益结论不可得（上游限制）。
2. `model_graded` 尚无真实模型端到端记录（P0 剩余项）。
3. `mutation` 仅支持文本 find/replace 注入，语义级变异未覆盖。
4. 全量 `craft` 单进程测试存在跨用例状态污染，尚未定位到具体模块。
