# craft-eval 理想态路线图（多阶段）

本文把"距理想态还差什么"落成**可执行的分阶段计划**。每个阶段都有：目标、现状缺口、实现要点、可验证的验收条件、明确的非目标。

基线：`craft-eval@0.7.2`，`npm test` 全绿。既有能力（执行、审计、统计、归因、实验、Scenario、MCP mock、`http_mock`、`rescore`、`requires/not_applicable`、`by_language`、`business` 四类模型、`mutation`、`calibrate`、`docs_links`、Windows shim）不再重复描述。

---

## 阶段总览

| 阶段 | 主题 | 核心交付 | 状态 |
|---|---|---|---|
| P0 | 判分强度地基 | `model_graded` + 可插拔 judge + 校准闭环 | 部分完成 |
| P1 | 多 judge 聚合 | 每用例多 judge、聚合策略、per-judge 报告 | 未完成 |
| P2 | 证据与可复现 | 失败自动保留证据、flaky 检测、跨 trial 一致性 | 未完成 |
| P3 | 数据集治理 | 版本谱系、污染溯源链、金集目录 | 部分完成 |
| P4 | 业务对象覆盖 | 业务 MCP、多轮业务 Agent、边界/对抗用例 | 部分完成 |
| P5 | 报告与集成 | HTML 增强、与 craft 主仓职责边界、运行手册 | 部分完成 |

各阶段设计文档：

- [P0 模型判断端到端](phase-p0-model-graded.md)
- [P1 多 judge 聚合](phase-p1-multi-judge.md)
- [P2 证据自动保留与 flaky](phase-p2-evidence-flaky.md)
- [P3 数据集版本谱系与污染溯源](phase-p3-dataset-governance.md)
- [P4 业务对象覆盖](phase-p4-business-objects.md)
- [P5 报告与集成](phase-p5-report-integration.md)

---

## P0：判分强度地基（`model_graded` 端到端）

### 目标

让"开放式输出"（文案、方案、报告）能被**可插拔的外部 judge** 评分，并且 judge 本身可信——先用金集校准，再用其判分。

### 现状

- `src/evaluation.ts` 已实现 `kind: 'model_graded'`：通过 `CRAFT_EVAL_JUDGE_ANSWER` / `CRAFT_EVAL_JUDGE_RUBRIC` 调用外部命令，解析 `{"score": 0..1, "reason"}`，按 `threshold` 判 passed/failed；判分失败记 `judge_error`（inconclusive，不当作低分）。
- `src/calibration.ts` 已实现 `calibrate <manifest>`：多轮打分，输出 `accuracy`（与金集一致率）与 `consistency`（自一致率）。
- craft-eval 自身**不内置模型**，模型选择完全由 judge 命令决定。

### 缺口

1. 缺少**可复现的金集目录**（只有单个 manifest 示例，没有版本化样本集）。
2. 缺少**真实 judge 端到端示例**（用规则式 stub 只能验证管线）。
3. 校准结果未进入 compare/analyze（见 P1、P2）。

### 验收条件

- 存在 `examples/judge-pool/`：≥10 个金样本，覆盖正例、负例、边界（空输出、超长输出、格式错误），每个样本带 `expected` 与 `provenance.source`。
- `craft-eval calibrate <manifest>` 对任一 judge 命令输出 `accuracy`、`consistency`、`per_sample`；对故意写坏的 judge（恒返回 1.0）能产出 `accuracy < 1`。
- 存在至少一条真实模型 judge 示例（命令可替换为本地 CLI 或 HTTP 网关），文档写明所需环境变量；无凭证时记录为环境缺失而不是判分失败。
- `npm test` 覆盖：`model_graded` 成功、judge 非零退出、非法 JSON、超时、输出超限 → `judge_error` / `inconclusive`。

### 非目标

- 不内置任何模型 SDK，也不替上层选模型。
- 不把 judge 分数合成为单一总分（P1 才引入聚合策略）。

---

## P1：多 judge 聚合（每用例多判分器）

### 目标

一个业务用例（如"电商详情页合规"）需要多个 judge 独立 verdict（合规性、转化、视觉一致性），再按声明策略聚合。

### 现状

- `Check.judge?: string` 已存在并写入 `CheckResult.judge`。
- `Comparison.judge_agreements` 类型已声明，但 `compareRunReports` **尚未计算**；`compareRuns` 也尚未输出 per-judge 视图。

### 缺口

1. 无聚合策略：`Case.threshold` 只作用于全体 checks 的加权通过率，没有"多 judge 全部通过 / 任一通过 / 加权"的独立语义。
2. 无 per-judge 报告：`report`/`compare` 不按 judge 分组展示分歧。
3. 无 judge 分歧归因：`analyze` 不认识"judge 分歧"这一失败类别。

### 验收条件

- `Case.judge_policy` 支持 `all_required`、`any`、`weighted`（含 `min_score`）。
- `report` 输出 `by_judge`：每个 judge 的 observed/passed/failed + 分歧用例列表。
- `compare` 输出 `judge_agreements`：同一用例在 baseline/candidate 下各 judge 的一致率。
- `analyze` 新增 `judge_disagreement` 分类，聚类并列出分歧用例。
- 测试覆盖三种策略 ×（全一致 / 部分分歧 / 全分歧）×（judge 报错）。

### 非目标

- 不引入自动权重学习（权重必须由 suite 作者声明）。

---

## P2：证据与可复现（失败自动留证、flaky 检测）

### 目标

失败时"证据自己会留下"，而不依赖人记得加 `--keep-traces`；多次 trial 不一致能被识别并标注。

### 现状

- `--keep-traces` 手动开启才保留 stdout/stderr/host-trace/gateway-trace/`outputs/`。
- `rescore` 依赖 captures 才能离线重打分。
- `trials` 支持 1..20，但**没有跨 trial 一致性统计**。

### 缺口

1. 失败用例默认不保留证据 → 事后无法 `rescore`、无法复核。
2. 无 `flaky` 判定：同一 case 多 trial verdict 不一致时不标记。
3. `analyze` 无 flaky 聚类。

### 验收条件

- `run --keep-traces on-failure`（新增取值）：仅对非 passed 的 (case,trial) 落盘 captures；`always`/`never` 保留原语义。
- `report` 输出 `flaky_cases`：同一 case 在 N 个 trial 中既有 passed 又有 failed/inconclusive 时列出，并给出各 verdict 计数。
- `analyze` 新增 `flaky` 分类，与既有 13 类并列。
- `compareRuns` 对 flaky case 明确标注，不把它们当稳定增益证据（`skill_gain_supported` 需排除 flaky）。
- 测试覆盖：稳定通过、稳定失败、flaky、单 trial（不判 flaky）。

### 非目标

- 不自动重试（重试属于 experiment 的 `retry` 语义）。

---

## P3：数据集治理（版本谱系与污染溯源）

### 目标

回答"这个结论基于哪个数据集版本""这条用例是否被污染、从哪来"。

### 现状

- `audit` 已有：重复 case id、重复 prompt、重复 acceptance、开发集/留出集复用、留出集审核与独立性、过期、无信息量检查。
- `Suite`/`Case` 有 `content_digest`、`provenance.source_digest`。
- `business` 模型有 `incidents`（事故回流用例）。

### 缺口

1. 无数据集**版本链**（`version` / `parent_digest`），无法追踪"哪个版本引入/删除了哪些用例"。
2. 污染检测只有"精确文本相等"，缺少**近似重复**（语义相似、模板化改写）。
3. 污染来源只到"哪个 suite"，没有到"通过什么路径泄漏"（共享 fixture、同一来源文档、训练集来源）。

### 验收条件

- `Suite.version`（语义版本）与 `Suite.parent_digest`（上一版 suite digest）可选声明；`audit` 校验 `parent_digest` 与已知版本一致，输出 `suite_lineage`。
- 新增 `craft-eval diff <old_suite> <new_suite>`：输出新增/删除/修改的 case id 与 digest，用于版本评审。
- 近似重复检测：基于规范化文本的 shingle Jaccard（阈值可配置，默认 0.9），命中时输出 `near_duplicate_prompt` 及双方 case id 与相似度。
- 污染来源：`Case.provenance.source` 相同且跨 development/held_out 时，输出 `shared_source_cross_partition` 并列出双方 case id。
- 测试覆盖：精确重复、近似重复（0.95/0.85 两档）、跨分区共享 source、版本链断裂。

### 非目标

- 不做模型训练数据级别的污染证明（craft-eval 无训练语料访问权）。

---

## P4：业务对象覆盖（MCP / 多轮 Agent / 边界对抗）

### 目标

评测对象不止"单个函数/单轮问答"，而是真实业务系统：业务 MCP、多轮 Agent、带人工介入的流程。

### 现状

- 已跑通：电商 Skill（877★ 第三方）、金融 MCP（loan-calculator）、电商 Agent（单轮）、Git 软件（dulwich）、quta。
- `mcp` mock（评测器当 MCP server）与 `driver` 模式（被测 MCP 当 service）均已支持。
- `http_mock` 可注入上游 SaaS fixture，无需改被测源码。
- `scenario` 支持线性多步骤 + 共享工作区 + checkpoint 续跑。

### 缺口

1. 未评测**电商类 MCP**（商品/订单/库存/支付），也缺少"业务规则边界"（券门槛、库存不足、退款时限）的用例矩阵。
2. 未评测**多轮 Agent**：单轮 prompt 无法覆盖"追问澄清、中途人工确认、状态回滚"。
3. 缺**对抗用例族**：提示注入（商品描述藏指令）、工具越权、跨租户数据泄漏。

### 验收条件

- 新增 `examples/real-world/ecommerce-mcp/`：一个可离线运行的电商 MCP（商品查询/下单/库存扣减），`driver` 模式驱动；用例覆盖正常下单、库存不足、券门槛边界（199/200/201）、重复下单幂等。
- 新增 `examples/real-world/agent-multiturn/`：`scenario` 驱动的多轮 Agent（3+ 步），其中一步要求人工确认（用 `requires` + 外部审批 stub），验证"未确认不执行"。
- 对抗用例：每个业务 MCP/Agent suite 至少 1 个 `mcp` mock 驱动的越权负例（`tool_call called:false`）与 1 个提示注入用例。
- 所有新 suite 通过 `audit`（无 error 级 finding）与 `coverage`（`undeclared` 为 0）。

### 非目标

- 不追求"覆盖所有电商业务"；每个对象只覆盖其核心规则集。
- 不引入需要真实凭证的 SaaS（用 `http_mock` 替代）。

---

## P5：报告与集成（可读性与职责边界）

### 目标

报告能直接支撑决策；与 craft 主仓的评测能力边界清晰、不重复。

### 现状

- `report-html` 输出静态 HTML（verdict 徽章、case 折叠、check 证据表、by_language）。
- craft 主仓有独立的 `core/evaluation.ts` 与 `capability/craft-eval/suite.ts`（三账本），与 craft-eval 并存。

### 缺口

1. HTML 缺少：judge 视图、flaky 标记、业务模型覆盖矩阵、mutation 分数。
2. `coverage` 只有通用标签维度，没有**业务模型派生维度**（每条不变量/规则/迁移被引用的用例数）。
3. 与 craft 主仓的职责边界没有成文约定，两套评测口径可能漂移。

### 验收条件

- `report-html` 增加：by_judge 表、flaky 列表、`business` 覆盖矩阵（不变量/迁移/规则 × 正例/负例/未覆盖）、mutation 分数（若存在）。
- `coverage` 输出 `by_business_invariant` / `by_business_transition` / `by_business_rule`，并给出"未覆盖条目"清单。
- 新增 `docs/ownership-boundary.md`：明确 craft-eval 负责"固定版本 + 证据产出"，craft 主仓负责"决策/发布/路由"；列出两套代码的职责与调用方式，禁止口径分叉。
- 新增 `docs/runbook.md`：业务套件运行手册（前置依赖、环境变量、失败排查、证据位置）。

### 非目标

- 不做在线仪表盘或持续服务；报告是静态产物。

---

## 全阶段共同约束

- **零新增运行时依赖**：判分器通过外部命令接入，不在 craft-eval 内引入模型 SDK。
- **证据不可伪造**：gateway 证据只在评测器内存成立；`rescore` 只重跑 `script`，不回读磁盘 gateway 副本。
- **环境缺失 ≠ 产品缺陷**：`requires` 未满足记 `not_applicable`，归因 `external_dependency_missing`。
- **结论不越界**：`mutation_score = 1` 只说明"声明的缺陷都被抓到"；不变量枚举不全时覆盖再高也只是"测了你知道的"。

## 验证方式

每个阶段结束时必须做到：

1. `npm run build` 通过；
2. `npm test` 全绿（含该阶段新增测试）；
3. 至少一条**真实对象**端到端运行记录（run 目录 + 摘要数字）写入对应阶段文档；
4. 文档与代码合同一致（字段名、默认值、错误码）。
