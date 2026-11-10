# 评测系统业界调研与 craft-eval 迭代方向

调研日期：2026-10-25。基线：`craft-eval` @ `d6e2b1d`（TypeScript 版，15 测试全绿）。

本文回答一个问题：**craft-eval 要成为一个好的通用评测系统，同时覆盖 craft 开发过程、外部 agent/软件、以及指令/skill 评测，该做什么、不该做什么。**

> 说明：`web_search` 工具在本次环境中持续失败（firecrawl/keenable 引擎报错），改用 `read_page` 直读一手来源与 GitHub API 完成。GitHub core API 一度耗尽配额（0/60），部分仓库信息通过 `read_page` 读取仓库页与 `raw.githubusercontent.com` 获得。

---

## 一、结论先行

1. **你提的「阿里 skill-upper」不是独立项目**，它是 `alibaba/skill-up`（★1314，Go，Apache-2.0）仓库内置的进化循环 Skill（`skills/skill-upper/`）。skill-up 是目前最贴近你目标的参考实现：它把「声明式用例 + 真实 Agent Engine + 三种判分 + with/without 对比 + 多引擎 CI」串成了完整闭环。
2. **craft 内部已有一套成熟评测体系，但重心在「证据编排/状态机」，不在「执行器」**。它明确不自己跑（"never starts a hidden Host"），唯一真 spawn 子进程的地方是 `engineering-evaluation-runner.ts`。这正好给 craft-eval 留出了生态位。
3. **skill / 指令触发评测是 craft 的真实硬缺口**，全仓 `should_trigger`、`skill.invoked` 均为 0 命中。这是 craft-eval 最该拿下、也最容易证明价值的一块。
4. **craft-eval 当前最大的设计缺陷是「触发判定自证」**：`skill.invoked` 由被测方自己写进轨迹，等于自己给自己评分。而它的 `trigger` 判定又没有和「skill 是否真实存在」关联。
5. **craft-eval 有一份比业界更严的统计口径（符号检验 + 摘要固定），这是资产，不该丢**。但它缺「失败原因分类」「离线重打分」「并行」「产物收集」这些工程能力。

---

## 二、业界主流框架：判分器与执行模型

### 2.1 判分器（scorer/grader）的四种形态

inspect_ai（UK AISI，Python 99.8%）把 scorer 归纳为四类（[来源](https://inspect.aisi.org.uk/scorers.html.md)）：

| 形态 | 举例 | 特点 |
|---|---|---|
| 从输出抽取答案 | `pattern()` `answer()` | 确定性、便宜 |
| 文本相似度 | `match()` `exact()` `f1()` | 确定性、需 target |
| 另一模型评判 | `model_graded_qa()` `model_graded_fact()` | 主观、需校准 |
| 任意 rubric | 数学等价 `math()`、格式合法性 | 领域特化 |

**值得偷的关键设计**：
- `Score` 同时携带 `Value`（CORRECT/INCORRECT/数值）、`Target`、**`explanation`（说明）**
- **scorer 与 metric 分离**：scorer 出分，`accuracy()`/`mean()`/`stderr()` 负责聚合
- 失败带**原因分类**：`reason="invalid_response_format"` 与 `reason="no_response"` 区分「格式不对」和「根本没输出」
- 支持**离线重打分**（`inspect score` 对已有 log 重新评分）与**多 scorer 组合**

### 2.2 门禁（gate）与判分（judge）分层

`alibaba/skill-up` 的多 judge 设计把两者明确分开（[来源](https://raw.githubusercontent.com/alibaba/skill-up/main/docs/design/multi-judge.md)）：

- **`expect` 是硬门禁**，失败则跳过所有 judge，case 直接 FAIL
- **judges 是独立判分成员**，每个有独立 verdict/artifacts/错误归属
- 聚合策略 `all_required`：全 PASS 才 PASS；任一 FAIL 且无 ERROR/SKIP → FAIL；有 ERROR/SKIP → ERROR
- 坦诚声明边界：**judges 共享同一文件系统，不是隔离**（"separate verdicts and sessions do not imply filesystem isolation"）
- 数值评分、权重、validator bundle 均列为**未来工作**（未实现）

### 2.3 断言模型的工程化：promptfoo

promptfoo（★26.4k，TypeScript 97.9%）的断言设计在「让断言可组合、可加权」上最成熟（[来源](https://www.promptfoo.dev/docs/configuration/expected-outputs/)）。

**断言对象的属性**：`type`、`value`、`threshold`、**`weight`（默认 1.0）**、`provider`、`rubricPrompt`、`config`、**`transform`（判分前先处理输出）**、`metric`、`contextTransform`。

**断言类型（一手清单，节选）**：

| 类型 | 含义 |
|---|---|
| `equals` / `contains` / `icontains` | 精确 / 包含（区分大小写） |
| `contains-any` / `contains-all` / `starts-with` | 集合包含 / 前缀 |
| `regex` | 正则 |
| `is-json` / `contains-json` | JSON 合法性 |
| `similar(0.8)` | 相似度 + 阈值 |
| `llm-rubric` / `grade` | 模型按 rubric 判 |
| `factuality` | 事实性 |
| `javascript` / `python` | **自定义代码判分** |
| `levenshtein(5)` | 编辑距离 |

**关键设计：`assert-set` 分组阈值**

```yaml
type: assert-set
assert: [...]          # 组内断言
threshold: 0.25        # 4 条等权断言中过 1 条即算这组通过
weight: 1.0
metric: ...            # 这组作为命名指标出现
```

这解决了「一个用例有多个维度，部分失败算不算整体失败」的问题——用**阈值**而不是全有全无。craft-eval 现在的 `verdictOf` 是严格全有全无。

### 2.4 执行与隔离：Docker 是事实标准

- **SWE-bench**：强制全容器化（"moving to a fully containerized evaluation harness using Docker for more reproducible evaluations"），结果按 `run_id` + `instance_id` 缓存，提供 `swebench report <run_id>` **离线重打分，不需要再起容器**（[来源](https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/README.md)）
- **SkillEvaluator Tier 3**：默认 Docker 沙箱，依赖 Harbor 做沙箱化 agent 运行
- **skill-up**：`environment.type` 三档 `none` / `docker` / `opensandbox`
- **inspect_ai**：独立 sandbox 抽象

**craft-eval 目前只复制目录**，README 自己也写明「工作区复制并非操作系统沙箱」。这在评测受信任的自有代码时够用，评测外部 agent 时不够。

### 2.5 Agent 基准怎么定义「成功」

| 基准 | 成功判据 | 隔离方式 | 备注 |
|---|---|---|---|
| **SWE-bench** | 生成的 patch 使 `FAIL_TO_PASS` 测试通过、且 `PASS_TO_PASS` 不被破坏 | **强制 Docker** | 结果按 `run_id`+`instance_id` 缓存；`swebench report` 可离线重打分 |
| **terminal-bench** | 每个任务自带 **test script** 验证是否完成 | 容器 | ~100 任务（beta）；新框架迁到 Harbor |
| **OSWorld** | VM 内真实桌面操作后的**状态检查** | **虚拟机**（VMware/Docker/KVM/Modal） | 支持并行把评测压到 1 小时内 |
| **tau-bench** | 多轮对话中的工具调用正确性与最终状态 | 代码内模拟环境 | 需多次采样看 reliability |

**共同模式**：成功判据一律是**可执行验证**（测试脚本 / 状态断言），不是「看起来对了」。这与 Anthropic 指南的「脚本判优于 LLM 判」完全一致。

---

## 三、Skill / 指令评测专章

### 3.1 事实标准：Anthropic Agent Skills 评测指南

来源：[agentskills.io/skill-creation/evaluating-skills](https://agentskills.io/skill-creation/evaluating-skills)（一手，官方）

**核心方法论**：每个用例跑**两遍**——`with_skill` 与 `without_skill`（或旧版本快照）。

产物契约：
```
skill-workspace/iteration-N/
  eval-<case-id>/
    with_skill/{outputs/, timing.json, grading.json}
    without_skill/{outputs/, timing.json, grading.json}
  benchmark.json
```

| 文件 | 作用 | 关键字段 |
|---|---|---|
| `evals/evals.json` | 作者手写 | `{skill_name, evals:[{id, prompt, expected_output, files[], assertions[]}]}` |
| `grading.json` | 每断言 PASS/FAIL | `assertion_results:[{text, passed, evidence}]` + `summary.pass_rate` |
| `timing.json` | 成本 | `total_tokens`, `duration_ms` |
| `benchmark.json` | 聚合 | `run_summary.{with_skill,without_skill}.{pass_rate,time_seconds,tokens}.{mean,stddev}` + `delta` |

**判分原则（原文要点）**：
- **PASS 必须有具体证据**，不给 benefit of the doubt
- 机械可查的用**脚本**判（比 LLM 判更可靠、可复用），其余才用 LLM judge
- 版本对比推荐 **blind comparison**：不告诉 judge 哪份来自哪个版本
- 剔除「两组都恒通过」的断言（无信息量，虚高 with_skill 分数）
- stddev 需要多次运行才有意义；早期只看原始计数与 delta

### 3.2 NVIDIA/SkillEvaluator：三层门禁模型

来源：[github.com/NVIDIA/SkillEvaluator](https://github.com/NVIDIA/SkillEvaluator)（★595，Python，Apache-2.0，论文 [arXiv:2608.20614](https://arxiv.org/abs/2608.20614)）

| Tier | 回答的问题 | 做法 |
|---|---|---|
| **Tier 1 Validation** | skill 是否**安全且结构良好** | Semgrep + SkillSpector + Gitleaks 扫描；`quality-check` 打分，**默认阈值 70** |
| **Tier 2 Deduplication** | 指引是否**重复/重叠** | embeddings 相似度，可跨 skill catalog 比对 |
| **Tier 3 Live Evaluation** | skill 是否**真的帮到 agent** | 沙箱里 with/without skill 对比跑 |

**门禁策略（值得直接借鉴）**：
- Tier 1 **总是** gate
- Tier 2 **默认** gate（`--no-block-on-dedup` 可降级为建议）
- Tier 3 **默认 advisory**（`--block-on-agent-eval` 才 gate）

**证据诚实性**：缺扫描器时明确报 `INCOMPLETE` 并以非零码退出，不假装通过。

### 3.3 alibaba/skill-up：最完整的工程实现

来源：[github.com/alibaba/skill-up](https://github.com/alibaba/skill-up)（★1314，Go，Apache-2.0）

能力清单（均为一手 README/docs 核实）：

| 能力 | 实现方式 |
|---|---|
| 配置形态 | `evals/eval.yaml` + `evals/cases/*.yaml`（文件名即 case id），YAML 而非 JSON |
| 判分 | `rule_based` / `script`（退出码）/ `agent_judge`（criteria + pass_threshold） |
| 声明式断言 | `expect: {exit_code, must_contain, must_not_contain}` |
| with/without 对比 | `benchmark.enabled: true` 自动两臂 |
| 环境隔离 | `none` / `docker` / `opensandbox` |
| 多 Agent Engine | `claude_code` / `codex` / `opencode` / `qodercli` / `qwen_code` + `engine.custom`（local/http） |
| MCP | `real` / `mocked`（mocked 会生成本地 stdio mock server） |
| 产物收集 | `collect_artifacts` doublestar glob，**成功/失败/超时都收集**，`.git/` 排除 |
| 并发 | `parallelism` 1~256 |
| 重试 | `retry_policy: {max_retries, retry_on: [timeout, error]}` |
| 报告 | Anthropic 兼容 `grading.json`/`benchmark.json` + `result.json` + JUnit XML + HTML |
| 会话契约 | `SessionInput` / `SessionResult`（`exit_code`/`final_message`/`transcript`/`turns`/`input_tokens`/`output_tokens`/`artifacts`） |
| CI | 官方 GitHub Action，Docker 容器，可跨引擎一次跑 |
| 安全 | `${ENV_VAR}` 引用；`command`/`args`/`cwd` 中禁止凭据形状（`sk-`/`ghp_`/`AIza`/`AKIA`/JWT），防止进程列表泄漏 |
| Anthropic 兼容 | `skill-up import evals.json` 迁移 |

### 3.4 关于「触发率」的诚实结论

**业界没有把「skill 触发率」作为一个独立指标去测**，而是统一用「with_skill vs without_skill 的任务通过率差」来表达 skill 的价值。原因很直接：触发是一个不可靠的中间量——skill 没被触发但任务照样做对了，说明这个 skill 本来就不是必需的。

真正衡量触发的方式是**行为观测**：在真实 engine 里装 skill，看轨迹里有没有走 `skill.invoked` 路径，再结合任务结果判断。skill-up 的 `agent_judge` 和 SkillEvaluator 的 Tier 3 都是这个思路。

craft-eval 目前把 `should_trigger` 做成一个独立的布尔判定，思路方向是对的（能区分「该触发没触发」和「不该触发却触发」），**但它的事件来源不可信**（见 4.2）。

---

## 四、craft 内部评测体系的真实成熟度

来源：craft 仓库源码核实（`core/`、`capability/`、`common/`）。

### 4.1 真实现 vs 空壳

**真实现（有内核 + 测试 + 入口）**

| 模块 | 位置 | 说明 |
|---|---|---|
| eval-suite | `core/eval-suite.ts:184/227` | `gradeCase` + `summarizeSuiteRun`；15 个 GradedCase；**明确禁止模型判分**（:16-20 注释：LLM judge "not reproducible and would make a score unfalsifiable"） |
| eval-campaign | `core/eval-campaign.ts:13` | Case×Trial×{baseline,candidate} slot 规划 + advance 聚合 |
| 符号检验 | `core/evaluation.ts:107` | `pairedSignTestProbability`，真 log 求和实现 |
| 配对判定 | `core/application/coordinators/evaluation-runs.ts:241` | runner/compare/promotion/reliability，p≤0.05 |
| **唯一真子进程执行器** | `core/application/engineering-evaluation-runner.ts:130` | mkdtemp 复制 fixture、codex dispatch、三段外部命令、workspace 前后 digest、超时/输出上限、argv 白名单（:34 禁绝对路径与 `..`） |
| 确定性评估器 | `core/application/acceptance-worker.ts:59` | 三个内置：file artifact sha256 / istanbul coverage / ffprobe；**只读外部工具产物，不 spawn** |
| 流程编排 | `capability/craft-experience/learning-evaluation.ts` | shadow/held_out/signoff/canary 真编排 |
| 5-trial 协议 | `core/runtime-acceptance.ts` | 严格多次试验 |
| judge 治理骨架 | `core/craft-service.ts:3959-3974` | `judgeAdapterSave`/`judgeCalibrationRecord`/`judgePromotionEligible`，**校准度门（agreement ≥ 0.8）**，但**没有任何地方用它打分** |

**空壳（别被文件名骗）**

| 文件 | 行数 | 实际内容 |
|---|---|---|
| `core/domain-evaluator.ts` | 22 | 只有 `metrics[key] >= criteria[key]` 纯算术比较，不执行任何东西 |
| `core/agent-eval-lab.ts` | 50 | 纯 store 校验 + idempotency，不执行 |
| `core/campaign-runner.ts` | 57 | 只 claim/bind/advance，注释明写 "never starts a hidden Host" |
| `core/task-benchmark.ts` | 94 | 只配对已观测的 Task Run，不跑模型 |
| `core/acceptance-worker.ts`、`capability/engineering-evaluation-runner.ts`、`core/interfaces/mcp/evaluation-handlers.ts` | 1~2 | 兼容 re-export |
| `common/craft-common-log/src/evaluation-contract.ts` | 79 | 7 阶段状态机，不是执行器 |

**一个容易误判的点：craft 有沙箱实现，但评测路径没用**

`core/docker-sandbox.ts`（142 行）和 `core/isolated.ts`（53 行）是真实实现，由 `core/application/service-foundation.ts:445-446` 装配，有专门测试（`tests/docker-sandbox.test.ts`、`tests/capability-access.test.ts`）。但 `core/application/engineering-evaluation-runner.ts` 走的是 `executeHostProcess`（来自 `core/host-driver.ts`，:196/:205），**没有接入这两个沙箱**。它的隔离手段是 `mkdtemp` 复制工作区 + `sandbox: "workspace-write"` 声明 + workspace 前后 digest 校验 + argv 白名单。

来源：`core/application/engineering-evaluation-runner.ts:196,200,205`；`core/application/service-foundation.ts:445-446`。

### 4.2 两套 stage：并行双体系，同名不同义

| 体系 | 位置 | 语义 | 是否导出 |
|---|---|---|---|
| **A. 能力成熟度门（7 阶段）** | `evaluation-contract.ts:4` | `mechanism→fixture→conformance→integration→host_verified→business_eligible→routeable`。只能前进一格；evidence 必须绑定 `verification_plan.change_ref = "<contract>:<stage>"`；`host_verified` 额外要求 `requires_real_host` | 是，有 MCP 工具消费 |
| **B. 候选上线流水线（4 阶段）** | `scenario-evaluation.ts:5` | `shadow/held_out/signoff/canary`。`signoff` 是自动策略 `craft:auto-signoff:all-prior-gates-passed.v1` | **未导出**，且 `learning-evaluation.ts:10` 又照抄一份 → 无单一事实源 |

**关系**：A、B 零引用、零 import、语义不重叠（一个是"能力可信到能路由了吗"，一个是"procedure 候选能不能上线"）。**不是死代码，但同名词不同义**。

**唯一真实的语义冲突**：`held_out` 在 B 里是**阶段名**，在 `delivery-evaluation.ts:22` 里是**分区名**。
**命名撞车**：`learning-evaluation.ts:81` 的 `evaluation_contract_digest` 指向 B 的 digest，与 A 的 `evaluation_contract` 记录毫无关系。

### 4.3 held_out 防污染：声明式契约，非检测式

三重保障（全部在源码核实）：
1. **内容寻址**：`case_set_ref` 必须等于 `stableDigest(cases)`（`scenario-evaluation.ts:41`），改一个字节就对不上
2. **集合互斥**：shadow/canary 的 `case_set_ref` 不得等于 held_out 的（`:52`，否则抛错）
3. **人工声明**：`independent_of_training === true`（`:42`）+ `approved_by` 非空（`delivery-evaluation.ts:24`）

**没有任何机制检测「这个 case 是否在训练/调参中见过」**——没有训练集 hash 比对、没有 provenance、没有 contamination 检测。`independent_of_training` 就是一个布尔声明，写它的人负责为真。

### 4.4 skill 评测：一行都没有（硬缺口）

全仓 grep 结果：
- `should_trigger`：**0 命中**
- `skill.invoked`：**0 命中**（该字符串只存在于 craft-eval 自己的代码里）
- `skill_id`：仅 `craft-service.ts:2565` 的 `studio_skill` 存储，与触发无关

craft 对 SKILL.md 只有两处接触：`core/catalog.ts:110` 当文件扫描建索引、`capability/craft-experience/procedure-projection.ts:231` 把 procedure 投影**写出**成 SKILL.md。`core/skill-publisher.ts` 只做原子落盘+digest+回滚。15 个 eval case 按 axis 分 memory/knowledge/workflow/governance/end_to_end，**没有 skill 轴**。

---

## 五、craft-eval 现状差距

| # | 差距 | 现状（含文件:行号） | 业界做法 | 严重度 |
|---|---|---|---|---|
| 1 | **触发判定自证** | `src/evaluation.ts:544` 靠被测方自己写 `skill.invoked` 进 trace | skill-up/SkillEvaluator 在真实 engine 里装 skill 观测 | **P0** |
| 2 | 判分只有 4 种确定性检查 | `exit_code`/`file_exists`/`json_equals`/`trace_event` | +script judge、+LLM judge（带校准）、+`must_contain` | P0 |
| 3 | 失败无原因分类 | `CheckResult.passed` 只有 true/false/null | inspect 区分 `invalid_response_format`/`no_response` | P1 |
| 4 | 无离线重打分 | 跑完即定，不能换判分器重判 | `inspect score`、`swebench report` | P1 |
| 5 | 串行执行 | `src/evaluation.ts:788-793` 双层 for | `parallelism` 1~256 | P1 |
| 6 | 无产物收集 | 只查 `outputs/` 下指定文件 | `collect_artifacts` glob，失败/超时也收集 | P1 |
| 7 | 无隔离 | 仅复制目录（README 自认非沙箱） | Docker / OpenSandbox / 独立 sandbox | P1 |
| 8 | 无 benchmark 两臂模式 | 靠手工跑两次 + compare | `benchmark.enabled` 自动 with/without | P1 |
| 9 | 无 skill 静态质量检查 | 不校验 SKILL.md、不查安全 | SkillEvaluator Tier1（quality score 阈值 70） | P2 |
| 10 | 无报告格式 | 只有 JSON | JUnit XML / HTML | P2 |
| 11 | 无 MCP 概念 | 无 | real/mocked MCP server | P2 |
| 12 | 无凭据形状防护 | 只拦 `CRAFT_EVAL_`/`DYLD_`/`LD_` 前缀 | 拦 `sk-`/`ghp_`/`AKIA`/JWT | P2 |
| 13 | 与 craft 契约未对齐 | Suite 字段自成一套 | 应对齐 `held_out`+`sanitized`+`approved_by` | P1 |

**craft-eval 的既有资产（不该丢）**：
- 符号检验 + 20 正例门槛，**统计严谨性严格强于** Anthropic 官方指南（官方明说早期只看 raw count）
- 内容摘要固定（`suite_digest` 防篡改）、Runtime 五维 digest、Run 目录不可变
- 「只留判定不留 stdout/轨迹原文」的隐私边界

---

## 六、建议

### 6.1 必须做（P0，决定这个系统是否有价值）

**1）修掉触发判定自证**
现在 `skill.invoked` 由被测方写，等于自证。最小可行改法：
- Suite 里声明 `skill_path`（指向真实 `SKILL.md`），craft-eval **启动时校验该 skill 存在且 frontmatter 合法**（`name`/`description` 必填）。本仓库有 52 个真实 SKILL.md 可作 fixture，已验证可解析。
- 轨迹事件必须由**评测器侧**产生或校验：给被测命令注入一个 wrapper/MCP shim，`skill.invoked` 由 wrapper 记录，被测方无法伪造。
- 没有 wrapper 时，至少把当前行为标注为 `self_reported: true`，让消费者知道证据强度。

**2）加 script judge，并区分 gate / judge**
- `expect`（硬门禁）与 `judge`（可聚合）分离，照 skill-up 的 `all_required`
- script judge：退出码 0=PASS、非 0=FAIL、超时/执行失败=ERROR（**三者不能混为一谈**）

**3）失败原因分类**
把 `CheckResult` 从 `passed: boolean|null` 扩展为带 `reason`：`not_found` / `invalid_json` / `key_missing` / `type_mismatch` / `timeout` / `no_trace`。这是可观测性的地基，成本低、收益高。

### 6.2 应该做（P1，决定好不好用）

**4）离线重打分（`craft-eval rescore`）**
SWE-bench 和 inspect 都有。价值：换了判分器不用重跑昂贵的 agent。前提是把「检查所需的最小证据」持久化（现在只存 sha256，需要存 `outputs/` 的受控快照）。

**5）并行 + 产物收集**
`parallelism`（注意工作区复制与临时目录的并发安全）+ `collect_artifacts` glob。

**6）benchmark 两臂模式**
`benchmark.enabled` 一次跑 with/without，直接产出 delta。这比现在的「手工跑两次 + compare」体验好一个量级。

**7）与 craft 契约对齐**
Suite 的 `partition`/`sanitized`/`approved_by` 已经与 craft 一致，继续保持。新增能力时优先对齐 `EvaluationCaseSet`（`case_set_ref`/`cases`/`independent_of_training`）和 `SessionResult` 字段，让 craft-eval 能作为 craft 的 **held-out 用例执行后端**：craft-eval 生产证据，craft 保留发证/路由权。

**8）补 contamination 防护**
craft 的 held_out 是纯声明式的，craft-eval 可以补它做不到的那层：记录用例来源/provenance，检测跨 suite 的 case 复用。

### 6.3 明确不做（P2 或不做）

- **不引入 Docker 作为默认**：craft-eval 的定位是轻量、零依赖、能在开发机上秒跑。Docker 做成可选后端（`environment.type: docker`），默认保持进程级复制。需要真隔离时调用方自己上容器。
- **不做数值评分体系**：skill-up 自己都把数值评分列为未来工作。verdict + evidence 已经够用，引入 0~100 分只会制造「分数怎么算」的无休止争论。
- **不做统一 stage 枚举**：craft 内部 A/B 两套 stage 是不同维度的两件事，craft-eval 不应该去合并它们，更不该自创第三套。
- **不追求「触发率」作为独立指标**：业界没有这么用。用 with/without 的任务通过率差表达 skill 价值，触发只作为诊断信号。
- **不做 LLM judge 的默认路径**：craft 的 `eval-suite.ts:16-20` 明确禁止模型判分（"would make a score unfalsifiable"），这个判断是对的。LLM judge 只作为**可选**判分器，且必须带校准记录（craft 已有 `judgeCalibrationRecord` 的 agreement ≥ 0.8 骨架可直接复用）。

---

## 七、需要你决策的问题

1. **craft-eval 与 craft 的关系**：是「craft 的内部模块」（共享代码、直接读写 craft DB），还是「独立 CLI + craft 通过 JSON 契约调用」？我倾向前者更省事、后者更通用，但两者在**错误处理与幂等性**上的要求完全不同。
2. **是否接受 `self_reported` 作为过渡态**：修触发自证需要注入 wrapper，这会影响被测命令的启动方式。是否先加字段标注、再逐步收紧？
3. **隔离策略**：外部 agent 评测是否必须 Docker？如果必须，craft-eval 的「零运行时依赖」定位就要放弃。
4. **两套 stage 命名冲突**（`held_out` 既是阶段又是分区）：在对接层是否显式改名（如阶段用 `held_out_stage`）？

---

## 八、参考来源

**一手规范与文档**
- Anthropic Agent Skills 评测指南：https://agentskills.io/skill-creation/evaluating-skills
- OpenTelemetry GenAI 语义约定（已迁至独立仓库）：https://github.com/open-telemetry/semantic-conventions-genai
- Inspect Scorers：https://inspect.aisi.org.uk/scorers.html.md
- Inspect 官方文档索引：https://inspect.aisi.org.uk/llms.txt

**参考实现**
- alibaba/skill-up：https://github.com/alibaba/skill-up
  - 写 eval：https://raw.githubusercontent.com/alibaba/skill-up/main/docs/guide/writing-evals.md
  - 多 judge 设计：https://raw.githubusercontent.com/alibaba/skill-up/main/docs/design/multi-judge.md
- NVIDIA/SkillEvaluator：https://github.com/NVIDIA/SkillEvaluator
  - 论文：https://arxiv.org/abs/2608.20614
- SWE-bench：https://github.com/SWE-bench/SWE-bench
- SWE-bench 论文（ICLR 2024 Oral）：https://arxiv.org/abs/2310.06770
- terminal-bench：https://github.com/laude-institute/terminal-bench
- Harbor（agent eval 框架）：https://github.com/harbor-framework/harbor
- NVIDIA SkillSpector：https://github.com/NVIDIA/SkillSpector

**LLM-as-judge 可靠性**
- Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena（NeurIPS 2023）：https://arxiv.org/abs/2306.05685
  - 结论：GPT-4 作为 judge 与人类偏好一致率 >80%；已知偏差包括**位置偏差、冗长偏差、自我增强偏差**，以及推理能力有限

**craft 内部（源码核实，无外链）**
- `core/eval-campaign.ts`、`core/eval-suite.ts`、`core/evaluation.ts`、`core/task-benchmark.ts`、`core/campaign-runner.ts`、`core/domain-evaluator.ts`、`core/agent-eval-lab.ts`
- `core/application/engineering-evaluation-runner.ts`、`core/application/acceptance-worker.ts`、`core/application/coordinators/evaluation-runs.ts`
- `common/craft-common-log/src/evaluation-contract.ts`、`capability/craft-experience/scenario-evaluation.ts`、`capability/craft-experience/learning-evaluation.ts`

**craft-eval 自身**
- `src/evaluation.ts`、`src/cli.ts`、`tests/evaluation.test.ts`、`README.md`
