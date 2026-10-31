# craft-eval

独立的评测执行器，面向软件、Agent、Skill 三类 `subject_kind`（合同保留 `subject_kind` 为自由字符串，但当前执行器只实现 software/agent/skill 三分支；其他取值会被 `audit` 标为 `subject_kind_unrecognized` 警告，且 `run` 不会为其提供专用执行路径）。一份版本化 Suite 定义任务与判据，一份 Subject 定义被测版本，一份 Runtime 固定环境、预算、Host、模型和工具。每个任务在复制的工作区中调用**受信任的本地命令**，从退出码、文件状态和 Host 轨迹判分；结果按 Run 分目录保存，不依赖共享数据库。

## 进程与输出边界

`runSuite` 的 `signal` 取消正在执行的工作，`max_output_bytes` 限制每个适配命令或模型裁判的 stdout/stderr 合计，默认 8 MiB。裁判超限记为 `judge_error` / `output_limit`，属于不确定结果，不按低分或通过处理；评分脚本只保留已有的有限诊断输出。

在 macOS/Linux 上，适配命令、评分脚本、模型裁判和用例服务由独立监护进程启动，实际命令使用独立进程组。命令正常退出时清理同组后代；执行器退出或被 SIGKILL 时，监护者通过 IPC 断开清理正在运行的命令。stdin/stdout/stderr 使用系统管道，监护者不通过 IPC 缓存输出。取消、超时、输出超限也通过该监护者终止命令。

环境依赖探测与裁判校准也走异步监护链：探测保留每次 5 秒时限并丢弃输出，取消时中止整次运行，不把取消伪装成“依赖缺失”。校准保留每次 60 秒默认时限，stdout/stderr 合计默认限 1 MiB；可通过 `calibrateJudge(path, { signal, timeout_ms, max_output_bytes })` 或 CLI `calibrate <manifest> --timeout-ms N --max-output-bytes N` 调整。取消校准会抛出取消原因，不继续评分或输出一份看似有效的部分准确率。超时和超限记为评分错误；统计规则不变。

`run --max-output-bytes N` 配置适配命令和模型裁判的合计输出上限。`--timeout-ms` 只用于 calibrate；其他命令错误使用这些选项会明确报错。单次执行、整个 Run 和重复校准都会捕获控制参数快照，中途修改调用者的原对象不会改变执行条件。新 Run 计划保存实际输出上限、有效并发度、工作区模式、失败即停与轨迹保留设置；比较前必须存在合法且一致的绑定。0.1.4 旧报告读回已由固定旧包生成的样本验证，但缺少绑定时不能推定条件一致；其他旧版本仍需单独兼容验证。

每条命令多一次 Node 启动，会增加短命令成本；可在源码仓库构建后用 `node scripts/benchmark-command-supervision.mjs 30` 本机实测。主动创建新会话逃离进程组的守护进程、监护者自身被 SIGKILL、Windows 整棵进程树仍是待完善或待验收的边界，不构成安全沙箱。详见 [监护设计](docs/command-supervision.md)。

## 显式上下文对照

Agent Subject 可以声明 `context: { "id": "claim-revision", "text": "待评估的精确知识正文" }`。执行器只对有 `host` 和 `prompt` 的任务注入它，文本最多 64 KiB；包含普通 `argv` 用例时拒绝运行，避免静默忽略。无 context 时保持原始 prompt 不变，便于与既有任务比较。

每个结果的 `input_receipt` 记录原任务、实际提交内容和上下文的 SHA-256；计划中的 `subject.context` 只保存 id/sha256。上下文改变会改变 Subject 摘要，不改变原任务摘要。可用 `prepareTaskInput` 构造并核对预期输入。原始 Subject 配置仍包含正文，Craft 受控运行会冻结该配置；摘要回执不代表原文已从评测目录删除。

回执只证明提交了哪些字节，不证明模型理解或采用了知识，更不签发知识晋级或发布许可。效果结论仍需要独立留出任务、相同环境与引擎配置、真实执行结果和统计护栏。测试中的模拟 Host 只验证输入与回执的实现。

## 安装与运行

需要 Node.js 22+。运行时零第三方依赖，仅用 devDependencies 里的 `typescript` 与 `@types/node` 做构建：

```bash
npm install          # 仅装构建期依赖
npm run build        # 产出 dist/src/
npm test             # 先构建，再跑 node:test
```

```bash
node dist/src/cli.js validate examples/software-suite.json
node dist/src/cli.js audit examples/software-suite.json examples/agent-suite.json
node dist/src/cli.js run examples/software-suite.json examples/software-subject.json examples/runtime.json \
  --workspace examples/workspace --output /tmp/craft-eval-runs --parallelism 2
node dist/src/cli.js run examples/software-suite.json examples/software-subject.json examples/runtime.json \
  --workspace examples/workspace --output /tmp/craft-eval-runs --workspace-mode isolated --fail-fast --keep-traces
node dist/src/cli.js report /tmp/craft-eval-runs/<run-id>
node dist/src/cli.js rescore /tmp/craft-eval-runs/<run-id> --workspace examples/workspace --output /tmp/craft-eval-rescore
node dist/src/cli.js compare /tmp/craft-eval-runs/<baseline-id> /tmp/craft-eval-runs/<candidate-id>
node dist/src/cli.js analyze /tmp/craft-eval-runs/<run-id>
node dist/src/cli.js report-html /tmp/craft-eval-runs/<run-id> --output /tmp/report.html
node dist/src/cli.js experiment experiment.json --workspace examples/workspace --output /tmp/craft-eval-experiments
node dist/src/cli.js coverage examples/software-suite.json examples/agent-suite.json
node dist/src/cli.js mutation mutation/manifest.json suite.json runtime.json \
  --workspace examples/workspace --output /tmp/craft-eval-mutation
node dist/src/cli.js calibrate judge-calibration.json
node dist/src/cli.js scenario scenario.json examples/agent-subject.json examples/runtime.json \
  --workspace examples/workspace --output /tmp/craft-eval-scenario

`run` 的全部选项：`--trials N`（重复次数，1..20）、`--parallelism N`（并发，1..8，含 `in_place` 的 Run 自动串行）、`--workspace-mode isolated|shared`（共享工作区用于线性 Scenario 的跨步依赖，普通 Suite 必须隔离）、`--fail-fast`（仅 shared 模式，首个非通过即停）、`--workspace-source <dir>`（从指定 checkpoint 恢复共享工作区）、`--keep-traces`（把每 case 的 stdout/stderr/host 轨迹/gateway 轨迹与实际 `outputs/` 产物保留到 `<run_dir>/captures/<case_id>-<trial>/`，默认仅留存摘要哈希）与 `--fail-on-failed`（出现 failed/inconclusive/invalid/missing 时返回 1）。

`rescore <run_dir> --workspace <dir> --output <dir>` 是**离线重打分**：它从 `--keep-traces` 保留的 `outputs/` 重新执行 `script` 检查，不启动 Host、不重跑被测对象，因此改判分脚本后可以秒级重新给出结论。它只重跑 `script`，其余检查保留原结论——尤其 `trace_event` / `tool_call` 的 gateway 证据只在评测器内存中成立，从不从磁盘副本回读，避免被测方伪造。

### 判分强度：assert-set、model_graded、校准

- **assert-set**：`Check.weight`（默认 1）+ `Case.threshold`（0..1，默认 1）。任务检查按加权通过率判分，例如 4 条等权检查设 `threshold: 0.25` 表示过 1 条即可；`safety_checks` 恒为全有全无。
- **model_graded**：`{"kind":"model_graded","command":["node","judge.mjs"],"answer":"outputs/answer.md","threshold":0.8,"judge":"quality"}`。评测器把 answer 路径与 rubric 通过 `CRAFT_EVAL_JUDGE_ANSWER` / `CRAFT_EVAL_JUDGE_RUBRIC` 传给 judge 命令，judge 输出 `{"score":0..1,"reason":"..."}`。**craft-eval 不内置模型**，模型选择与调用方式完全由 judge 命令决定。
- **calibrate**：`calibrate <manifest>` 在 gold set 上多轮跑 judge，输出 `accuracy`（与已知答案一致率）与 `consistency`（重复打分自一致率）。judge 不可信时先校准，再用于评测。

### 业务模型与充分性论证

完整方法论见 [`docs/business-coverage-methodology.md`](docs/business-coverage-methodology.md)：五个透镜（不变量、生命周期、边界/等价类、对抗/合规、事故回流）+ 变异分数。落地形式：

```json
{
  "business": {
    "invariants": [{"id":"inv-1","statement":"摊销末期余额为 0","positive_cases":["c1"],"negative_cases":["c2"]}],
    "transitions": [{"id":"t1","entity":"order","from":"created","to":"paid","allowed":true,"cases":["c3"]}],
    "incidents": [{"id":"inc-1","source":"issue-42","case_ids":["c4"]}]
  }
}
```

- `audit` 派生检查：不变量缺正例/负例、引用未知 case、生命周期迁移未被任何用例触达、事故没有回归用例。
- `coverage`：按 category/risk/difficulty/language/check-kind 输出覆盖矩阵与 `gaps`，`undeclared` 不隐藏。
- `mutation`：对 baseline 副本逐个注入缺陷（manifest 的 `find`/`replace`，可用 `subject_env` 的 `{{copy}}` 把变异副本接进被测命令），输出 `mutation_score`、`killed/survived/errored`。幸存缺陷是**用例盲区**，不是产品 bug。
- 诚实边界：mutation_score=1 只说明"声明的缺陷都被抓到"，不证明评测完美；不变量枚举不全时覆盖再高也只是"测了你知道的"。
```

安装为依赖后也可直接用 `craft-eval <command>`（对应 `package.json` 的 `bin`）。`npm test` 先构建再运行测试（`node:test`）。`run` 打印 Run 目录和报告；配置或执行错误返回退出码 2。`--fail-on-failed` 在出现 failed/inconclusive/invalid/missing 时返回 1，`compare --require-gain` 在增益未获支持时返回 1，`audit` 在出现 error 级质量问题时返回 1；三者仍先输出完整 JSON。`--parallelism` 接受 1..8，独立 case/trial 可并发，含 `in_place` 的 Run 自动串行。软件示例只验证基础执行链，Agent/Skill 的完整正反例和配对运行见 `tests/evaluation.test.ts`，新增合同、审计、统计、归因、实验和 Scenario 的测试见 `tests/extensions.test.ts`。

## 评测方法与定位

`craft-eval` 是**独立证据执行器**，不是发证、路由或发布系统。它负责固定被测版本、Suite、Runtime 和重复次数，执行确定性检查，输出可复核结果；上层仍保留“是否上线”的决策权。评测设计按七个环节闭环：

1. **评测对象与主张**：明确评的是长链路复杂系统、单软件、Agent、MCP 还是 Skill，以及结论允许覆盖的范围。
2. **评测标准与指标**：一个主指标加若干 Guardrail，任务、安全、时延、成本分开报告，不合成单一总分。
3. **高质量评测集**：用例要有来源、所有者、难度、风险、期望行为、独立性和过期时间；开发集与留出集不得复用。
4. **执行链路与结果**：固定 Host、模型、工具和预算，保留缺失、未判定、无效与基础设施失败。
5. **归因分析**：基于检查原因、触发证据和 Host 观测分类失败，不读取模型思维链。
6. **迭代与决策**：候选必须有配对改善、Guardrail 通过和独立留出证据；修复后回流为回归 Case。
7. **有预算的重复实验**：固定种子、断点续跑、显式重试记录，避免反复筛选导致过拟合。

真实 Codex 或 Claude CLI 是**可选依赖**：本机已安装时可作为 Agent 执行 Host；普通软件和本地脚本评测仍用 `argv`，不要求安装或联网。`group/free` 等路由别名不等于零成本，成本未知时保持 `null`。

## 评测合同与质量审计

Suite 新增字段均为可选，旧 Suite 仍可运行。建议为每个主张声明：

```json
{
  "claim": {
    "statement": "该版本在离线检索任务上优于基线",
    "scope": "内部工具 v1，不含线上流量",
    "limitations": ["仅覆盖 50 条留出任务"]
  },
  "metrics": {
    "primary": {"id": "task_pass", "kind": "binary_pass_rate", "direction": "higher_is_better", "minimum_sample": 20},
    "guardrails": [
      {"id": "latency", "metric": "duration_ms", "comparator": "lte", "threshold": 30000},
      {"id": "cost", "metric": "cost_units", "comparator": "lte", "threshold": 1}
    ]
  },
  "owner": "eval-team",
  "source": "issue-123",
  "expires_at": "2026-12-31",
  "boundaries": {"allowed_hosts": ["codex"], "allowed_tools": ["read"], "network": "unobserved"}
}
```

Case 可声明 `tags`、`category`、`difficulty`、`risk`、`owner`、`expected_behavior`、`claim` 和 `provenance`。留出用例建议写明 `provenance.reviewed_by` 与 `provenance.independent_of_training`。`sanitized: true` 只表示已脱敏，**不是污染或独立性的证明**。

Case 还可声明 `requires` 与 `language`。`requires` 是**环境门控**：`commands`（PATH 上必须有）、`env`（变量必须非空）、`python_modules`（`py -3 -c "import <name>"` 必须成功）。任一不满足时该 case 记为 **`not_applicable`**（`issue: requirement_unmet:<tag>`），**不计为 failed**，`analyze` 归因为 `external_dependency_missing`。`language` 用于 `report.by_language` 的按语言聚合（`expected/passed/failed/not_applicable`），便于发现「Python 检索 MRR=0」这类单语言退化。

`audit <suite...>` 输出 `craft-eval.audit.v1`，检查重复 Case ID、规范化 prompt 重复、验收条件重复、开发集/留出集复用、留出集审核与独立性声明、过期、缺失主张/指标/来源/期望行为，以及无信息量检查。Error 会让命令返回 1。

`examples/agent-suite.json`、`examples/agent-subject.json` 是**离线可跑**的 agent-kind + `argv` 示例（`--workspace examples/workspace`）；它不要求真实 Host，验证的是执行链，不是 Agent 能力。要驱动真实 Codex 执行任务，用 `examples/agent-codex-suite.json` + `examples/agent-codex-subject.json` + `examples/runtime.json`，并加 `--workspace examples/workspace --output <dir>`：该 Subject 的 `subject.host.binary` 指向本机 Codex，`model` 用 `group/free`。这条路径需要 Codex 已登录且能联网；Codex 事件不暴露真实模型与成本，因此 `observed_models` 为空、`cost_usd` 为 `null`。Skill 示例用 `examples/skill-suite.json` 分别配 `examples/skill-baseline.json`、`examples/skill-candidate.json` 运行两次，再用 `compare` 对比输出的 Run 目录。示例 Host 轨迹是演示数据；两个正负例只用于验证接线，不满足增益判定所需的至少 20 个正例。实际评测应提供独立留出用例和真实 Host 轨迹。

## Suite 合同

```json
{
  "schema": "craft-eval.eval.v1",
  "suite_id": "release-check",
  "subject_kind": "software",
  "partition": "held_out",
  "sanitized": true,
  "approved_by": "independent-reviewer",
  "cases": [{
    "id": "starts-and-writes-state",
    "argv": ["node", "host.mjs"],
    "timeout_s": 30,
    "checks": [{"id": "exit", "kind": "exit_code", "equals": 0}],
    "safety_checks": [{"id": "state", "kind": "json_equals", "path": "outputs/result.json", "key": "safe", "equals": true}]
  }]
}
```

支持 `exit_code`、`file_exists`、`json_equals`、`trace_event`、`script`、`tool_call`、`stdout_contains`、`stdout_not_contains` 八种确定性检查。`checks` 衡量任务结果，`safety_checks` 单列安全回归；`script` 按退出码判分（默认 0 为通过，`pass_exit_codes` 可扩展），失败原因记录在 `reason`（如 `not_found`、`invalid_json`、`key_missing`、`script_failed`、`tool_not_called`、`arguments_mismatch`），便于区分"文件不存在"与"文件存在但不可解析"。

### MCP 评测（mocked server 注入）

用例可声明 `mcp`：评测器为每个 server 启动**自己实现的 stdio mock MCP server**（JSON-RPC 2.0，协议版本 `2024-11-05`，零依赖），通过环境变量 `CRAFT_EVAL_MCP` 注入描述符：

```json
{
  "id": "use-search",
  "argv": ["node", "host.mjs"],
  "mcp": [{
    "name": "search",
    "tools": [{
      "name": "lookup",
      "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
      "response": {"content": [{"type": "text", "text": "found:1"}]}
    }]
  }],
  "checks": [
    {"id": "called", "kind": "tool_call", "server": "search", "tool": "lookup", "called": true},
    {"id": "args", "kind": "tool_call", "server": "search", "tool": "lookup", "called": true, "with_arguments": {"q": "craft"}},
    {"id": "forbidden", "kind": "tool_call", "server": "search", "tool": "delete-all", "called": false}
  ]
}
```

被测 agent 作为普通 MCP 客户端连接（任何支持 stdio transport 的 SDK/CLI 都可以）。关键点：**`tool_call` 检查的证据来自评测器侧 mock server 的调用日志，而不是被测方写的轨迹**——被测方无法声称一次没有发生的工具调用。支持断言「被调用且参数匹配」（`with_arguments`）与「不得被调用」（`called: false`，负例）。每个用例最多 8 个 server、每 server 最多 32 个工具。

### HTTP fixture 注入（`http_mock`）

业务 MCP 常依赖外部 SaaS API。用例可声明 `http_mock`，评测器在 `127.0.0.1` 上启动零依赖 fixture server，并把 base URL 注入指定环境变量；被测代码继续调用自己的客户端，只是地址指向 fixture，**无需修改被测仓库源码**：

```json
{
  "id": "quote",
  "argv": ["node", "server.mjs"],
  "http_mock": [{"env": "PRICING_API", "routes": [
    {"method": "GET", "path": "/price", "body": {"price": 42}},
    {"method": "POST", "path": "/coupon", "status": 201, "body": {"ok": true}}
  ]}],
  "checks": [{"id": "price", "kind": "json_equals", "path": "outputs/result.json", "key": "price", "equals": 42}]
}
```

`env` 必须是合法变量名且不能以 `CRAFT_EVAL_` 开头；每用例最多 8 个 fixture server、每 server 最多 64 条路由。请求记录在评测器内存中，未命中路由返回 404，不会回落到真实网络。配合 `driver` 模式即可离线评测「真实业务 MCP 的 stdio 工具实现」；配合普通 `mcp` mock 则可评测「Agent 对业务工具的编排」。

Skill Case 必须声明 `skill` 绑定：`{"skill_id", "skill_path", "should_trigger"}`。评测器在运行前解析 `skill_path/SKILL.md`，校验 frontmatter 的 `name` 与 `skill_id` 一致，并把内容摘要绑定进 Run 计划——一个 bare id 不是证据。正例需要任务检查，负例可以只有触发检查。留出集必须声明脱敏和独立审核人。Suite、Subject 和 Runtime 以内容摘要固定，比较只接受同 Suite、同运行条件、同重复次数的 Run。

## 真实 Host（可选）

`craft-eval` 不硬依赖 Claude Code 或 Codex CLI。普通 `argv` Subject 仍是默认路径；需要让真实 Agent 执行任务时，在 Subject 中声明 `host`，Case 用 `prompt` 提供任务，二者与 `argv` 互斥：

```json
{
  "kind": "agent",
  "id": "codex-eval",
  "version": "v1",
  "host": {
    "kind": "codex",
    "binary": "D:\\application\\codex\\resources\\codex.exe",
    "model": "group/free",
    "sandbox": "workspace-write"
  }
}
```

```json
{
  "id": "fix-test",
  "prompt": "修复测试并说明结果",
  "checks": [{"id": "exit", "kind": "exit_code", "equals": 0}]
}
```

Codex 通过 stdin 接收提示词，使用 `codex exec --json --ephemeral --skip-git-repo-check --sandbox ... -C <sandbox> -`；Claude 使用 `-p --output-format stream-json --verbose --no-session-persistence --permission-mode dontAsk`。`args_prefix` 可插入可信包装参数（例如测试替身），`env` 可设置 Host 自己的配置目录；两者都不能覆盖 `CRAFT_EVAL_*`、`DYLD_*` 或 `LD_*` 控制变量，Host 配置中的未知字段会被拒绝，避免拼写错误被静默忽略。

Host 进程由评测器启动，工作区仍是复制后的 sandbox。结果中的 `host` 分别记录 `requested_model` 与 `observed_models`：请求别名不等于实际模型；Codex 当前事件不暴露实际模型和成本，因此这两项为 `null`/空数组，不猜测。Claude 的 `Skill` 工具调用可映射为评测器观测的 `skill.invoked`；Codex 当前事件没有明确 Skill 调用，因此 Skill 触发保持 `unobserved/inconclusive`。Host 输出不是合法 JSONL、超过 8 MiB、缺少终态或进程不可启动时，不会退化成“通过”。

## Host 轨迹合同

运行命令可读取 `CRAFT_EVAL_RUN_ID`、`CRAFT_EVAL_TASK_RUN_ID`、`CRAFT_EVAL_CASE_ID`、`CRAFT_EVAL_TRIAL`、`CRAFT_EVAL_OUTPUT_DIR`、`CRAFT_EVAL_TRACE_PATH`，Skill 用例额外读取 `CRAFT_EVAL_SKILL_ID` 与 `CRAFT_EVAL_SKILL_DIGEST`。普通适配器只能把 JSONL 写入 `CRAFT_EVAL_TRACE_PATH`，每行 `source` 必须是 `"host"`，且带本次 `task_run_id`。评测器把从自己启动的 Host stdout 解析出的 gateway 事件写入 `gateway-trace.jsonl` 仅作审计；该文件**绝不回读为判分证据**，因此被测方即使从 `CRAFT_EVAL_TRACE_PATH` 推导并伪造它也不会生效。`source: "gateway"` 写在 host 轨迹中会使整条 host 轨迹无效。Skill 实际调用写 `{"event":"skill.invoked","skill_id":"..."}`；结束时写 `{"event":"run.finished"}`。缺少终态或轨迹无效，触发与轨迹检查为**未判定**；没有调用事件不能自动推断"未触发"。终态事件可包含非负的 `cost_units`；未提供时成本显示为未测量。

Agent 用例即使只检查输出文件，也必须有完整 Host 轨迹才能得到通过结论。

### 触发证据分级

触发判定带 `evidence` 字段，分三级：

- **`gateway`**：由评测器启动并解析真实 Host 事件，且证据只在评测器内存中成立；磁盘上的审计副本不回读。被测方无法伪造。唯一能支持增益声明的证据等级。
- **`self_reported`**：由被测方自己写入。可以用于诊断，但**永远不能**支持增益声明——被测方报告自己的成功什么也证明不了。
- **`unobserved`**：无评测器可观测的终态轨迹，或只有被测方轨迹且没有调用事件。触发未判定。

Skill 增益比较要求同一留出 Suite 至少 20 个不同正例、一个负例、独立 TaskRun、候选无触发错误和安全失败、**全部触发证据为 `gateway`**、任务配对有改善且单侧符号检验 `p ≤ 0.05`。任何 `self_reported` 或 `unobserved` 触发都会让 `skill_gain_supported` 为 `false`，并在 `gateway_observed_triggers` / `unobserved_triggers` 中给出原因。返回 `skill_gain_supported` 仅表示这组任务上的证据支持改善，不授予发布权。任务、触发、安全、时延与成本分别报告。

**Host 触发证据的已知上限**：`gateway` 级触发需要 Host 在事件流里暴露 Skill/工具调用。Claude 的 `Skill` 工具调用可映射为评测器观测的 `skill.invoked`，因此 Claude 适配器的 skill 评测可产出 `gateway` 证据；**Codex 当前事件不暴露 Skill 调用**，所以 Codex 模式下 Skill 触发恒为 `unobserved/inconclusive`，用 Codex 跑的 skill 评测永远拿不到 `skill_gain_supported`。这是上游 Host 能力限制，不是本工具代码能补的。`audit` 会在 skill Suite 正例不足 20 或缺少负例时给出 `skill_gain_sample_insufficient` / `skill_gain_no_negative` 警告，提前避免无意义的增益比较。

符号检验要求用例彼此足够独立；反复调参或多候选筛选需要另留最终测试集，避免选择偏差。

## 七环节对照表

你的评测闭环与 `craft-eval` 命令的对应关系（craft-eval 负责 1–5 的执行与证据，6–7 由上层闭环拥有，本工具只产出 JSON 契约）：

| 环节 | 问的是 | 本工具提供的对象 / 命令 |
| --- | --- | --- |
| 1 评测对象与主张 | 评谁、结论范围 | `subject_kind`（software/agent/skill/其他）、`Suite.claim`、`Suite.metrics.primary` |
| 2 评测标准与指标 | 看什么 | `checks` / `safety_checks` / `metrics.guardrails`（任务、安全、时延、成本分列，不合成总分） |
| 3 评测集 | 用什么测 | `audit`（重复、污染、留出集复用、审核与独立性、过期、无信息量检查）+ `Case.provenance` |
| 4 执行链路与结果 | 跑出什么 | `run`（共享/隔离工作区、fail-fast）、`report`（plan/recorded/passed/failed/inconclusive/invalid/missing） |
| 5 归因分析 | 为什么失败 | `analyze` → `craft-eval.attribution.v1`（检查原因、触发、Host 观测、trace 完整性分类；不读模型思维链） |
| 6 迭代与决策 | 是否修复/上线 | **上层拥有**：本工具只给配对增益（`compare --require-gain`）、Guardrail 与 `skill_gain_supported`，不自动改码或发布 |
| 7 重复实验 | 在预算内复现 | `experiment`（固定种子、续跑、成本预算 `max_cost_units`、`cost_unobserved` 不折算 0、显式 `skipped`） |

长链路系统用 `scenario`（线性步骤、共享工作区、checkpoint 续跑）替代任意 DAG；真实 Agent 执行通过 `subject.host` 桥接 Codex/Claude（可选依赖，本机未装时不阻塞软件/脚本评测）。

## 统计、归因与实验编排

`compare` 现在同时报告：

- 主指标的二值配对结果：候选胜/基线胜/平局、风险差、风险差 95% Bootstrap 区间、odds ratio、phi 和单侧符号检验 `p`。
- 连续指标：均值、中位数、p95、方差、标准差，以及配对均值差、标准化差和 95% Bootstrap 区间。
- `metrics.guardrails` 的逐项结果；Guardrail 失败会阻止 `skill_gain_supported`。

所有 Bootstrap 使用固定种子和确定性伪随机数，相同输入重复运行得到相同结果。主指标和 Guardrail 不会被压成一个总分。

`analyze <run_dir>` 输出 `craft-eval.attribution.v1`。归因只使用结构化证据，例如检查原因、触发判定、Host 观测、退出状态和 trace 完整性；不会读取模型思维链。类别包括基础设施、fixture、Host、模型、Skill 未触发/误触发、错误工具/参数、权限、超时、恢复失败、输出无效和安全违规。报告同时给出首个失败阶段、首个失败检查、失败聚类以及最慢和最贵的 Case。

Experiment Manifest 用于 `Subject × Runtime × Suite × Trial` 矩阵：

```json
{
  "schema": "craft-eval.experiment.v1",
  "experiment_id": "matrix-2026-10",
  "suites": ["suites/dev.json", "suites/held-out.json"],
  "subjects": ["subjects/baseline.json", "subjects/candidate.json"],
  "runtimes": ["runtime.json"],
  "trials": 3,
  "parallelism": 2,
  "seed": 42,
  "budget": {"max_jobs": 40, "max_cost_units": 1000},
  "retry": {"max_attempts": 2, "only_verdicts": ["inconclusive", "invalid"]}
}
```

相对路径按 Manifest 所在目录解析。`experiment.json` 保存已完成 Job，重新运行会跳过已完成项；失败或指定 verdict 的重试会追加新 attempt，不覆盖原始结果。预算耗尽时未执行项明确标记为 `skipped`，不做静默截断。

预算有两类上限：`max_jobs` 限制总执行数；`max_cost_units` 限制累计 `cost_units`。当任何已完成 Job 的成本不可观测（`cost_units` 为 `null`）时，未观测成本不折算为 0，而是 `cost_observed: false`，并在第一个不可观测 Job 出现时把剩余未执行项标记为 `skipped`、`budget_reason: "cost_unobserved"`；此时报告里的 `cost_units` 为 `null`。`max_cost_units` 只在全量可观测时生效。改变 Manifest 会让续跑报错（除非旧报告的 `manifest_digest` 为空，视为旧格式兼容）。

## 线性 Scenario

长链路系统先使用线性 Scenario，而不是任意 DAG：

```json
{
  "schema": "craft-eval.scenario.v1",
  "scenario_id": "migrate-service",
  "steps": [
    {"id": "inspect", "prompt": "检查当前服务", "checks": [{"id": "read", "kind": "exit_code", "equals": 0}]},
    {"id": "change", "prompt": "完成迁移", "checks": [{"id": "exit", "kind": "exit_code", "equals": 0}]},
    {"id": "verify", "argv": ["node", "verify.mjs"]}
  ],
  "checkpoints": [
    {"id": "after-inspect", "after_step": "inspect", "checks": [{"id": "state", "kind": "file_exists", "path": "outputs/inspect.json"}]}
  ],
  "final_checks": [{"id": "final", "kind": "json_equals", "path": "outputs/result.json", "key": "ok", "equals": true}],
  "recovery": {"on_interruption": "resume"}
}
```

Scenario 的每一步复用普通 Case 执行器，按 `steps` 顺序在同一**共享工作区**中执行，`fail-fast` 在第一处失败即停。步骤可以混合：纯 `argv` 步骤作为本地校验执行，带 `prompt` 的步骤交给 Subject 声明的真实 Host（`codex`/`claude`）执行；二者在同一个工作区里串接。每步执行后可写 checkpoint 快照，配合 `recovery.on_interruption: "resume"` 与 `--resume-after <step>` 能从指定步骤之后续跑，工作区沿用上次检查点。`final_checks` 与 `checkpoints` 检查都进入同一证据链；实际执行时输出 `scenario-report.json`，记录完成到哪一步、首个失败步骤/检查及所有尝试。任意图、自动恢复策略和审批状态机不在当前范围内。

## 上层闭环契约

`craft-eval` 只提供 JSON 证据契约，不自动改代码、发布、调度 Canary 或做路由决策。推荐闭环是：开发集迭代 → 独立留出集验证 → 人工审批 → Canary → 线上监控 → 将事故转为回归 Case → 再进入下一轮评测。上层必须保留最终发布权，并明确区分“配置成功”“测试通过”和“真实环境生效”。

## 运行边界

- 命令通过 argv 直接执行，没有 shell 展开。工作区逐任务复制，忽略 `.git`、`.craft_data`、`.venv`、`node_modules` 和 `__pycache__`，拒绝输入符号链接；检查器也拒绝通过输出符号链接读工作区外文件。
- **只运行受信任的命令与 Host 适配器。** 工作区复制并非操作系统沙箱，不能阻止命令访问网络或机器上其他路径。需要执行不受信任代码时，先在外部容器/虚拟机里运行本工具。
- 结果只保留检查结果、摘要和数值，不保存 stdout、stderr 或原始轨迹。输出目录不得位于输入工作区内。每项任务有独立目录与 TaskRun ID；计划数、已记录数、失败、未判定、无效和缺失数均在报告中列出。
- 已支持可选的 Codex / Claude Host 适配器，并用本地假 CLI 验证事件解析；真实 Codex/Claude smoke 需要在目标机器配置登录、模型路由和网络。真实 Host 仍受其自身权限模型约束，工作区复制不是 OS 沙箱。本工具是**独立 CLI**，通过 JSON 契约与上层（如 craft）协作：craft-eval 生产证据，上层保留发证与路由权。推荐把 Codex 作为默认的可选真实 Host，Claude 作为可选适配器；二者都不是硬依赖。免费路由别名（如 `group/free`）不保证零成本，结果会分别记录请求模型、观测模型、token 与可得的成本，未知项保持 `null`。
 - `--keep-traces` 会在 Run 目录内保留每 case 的原始 stdout/stderr 与 host/gateway 轨迹，便于诊断失败；默认不保留，仅留存摘要哈希，避免 Run 目录膨胀并防止原始轨迹被当作判分证据回读。
 - 本机已用真实 Codex CLI（`codex exec --json` + `group/free`）端到端跑通 agent-kind 冒烟（`verdict: passed`、完整 host 轨迹、可观测 token 与 tool_calls），证明 Codex 适配器的事件解析链路真实可用；该路径要求 Codex 已登录（如 `CODEX_CI=1` 的非交互凭证）且能联网，未登录或离线时不应假设它能跑通。
- 在 Windows 上，目录链接（junction）无需开发者模式或管理员权限，文件符号链接则必须提权。拒绝规则覆盖两者：检查器逐级 `lstat`，任何链接（`isSymbolicLink()`）都按"路径穿越"拒绝，因此安全用例以 junction 驱动即可，不需要提权。

## 类型与模块

源码在 `src/`（`evaluation.ts` 为核心，`cli.ts` 为命令行，`index.ts` 为导出入口），编译产物在 `dist/`。`npm test` 先编译再运行 `dist/tests/*.test.ts` 对应的测试。
