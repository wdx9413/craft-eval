# craft-eval

独立的评测执行器，面向软件、Agent、Skill，也允许其他 `subject_kind`。一份版本化 Suite 定义任务与判据，一份 Subject 定义被测版本，一份 Runtime 固定环境、预算、Host、模型和工具。每个任务在复制的工作区中调用**受信任的本地命令**，从退出码、文件状态和 Host 轨迹判分；结果按 Run 分目录保存，不依赖共享数据库。

## 安装与运行

需要 Node.js 22+。运行时零第三方依赖，仅用 devDependencies 里的 `typescript` 与 `@types/node` 做构建：

```bash
npm install          # 仅装构建期依赖
npm run build        # 产出 dist/src/
npm test             # 先构建，再跑 node:test
```

```bash
node dist/src/cli.js validate examples/software-suite.json
node dist/src/cli.js run examples/software-suite.json examples/software-subject.json examples/runtime.json \
  --workspace examples/workspace --output /tmp/craft-eval-runs
node dist/src/cli.js report /tmp/craft-eval-runs/<run-id>
node dist/src/cli.js compare /tmp/craft-eval-runs/<baseline-id> /tmp/craft-eval-runs/<candidate-id>
```

安装为依赖后也可直接用 `craft-eval <command>`（对应 `package.json` 的 `bin`）。`npm test` 先构建再运行测试（`node:test`）。`run` 打印 Run 目录和报告；CLI 出错返回退出码 2。软件示例只验证基础执行链，Agent/Skill 的完整正反例和配对运行见 `tests/evaluation.test.ts`。

`examples/agent-suite.json`、`examples/agent-subject.json` 可直接替换上述软件 Suite 和 Subject 运行 Agent 示例。Skill 示例用 `examples/skill-suite.json` 分别配 `examples/skill-baseline.json`、`examples/skill-candidate.json` 运行两次，再用 `compare` 对比输出的 Run 目录。示例 Host 轨迹是演示数据；两个正负例只用于验证接线，不满足增益判定所需的至少 20 个正例。实际评测应提供独立留出用例和真实 Host 轨迹。

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

支持 `exit_code`、`file_exists`、`json_equals`、`trace_event` 四种确定性检查。`checks` 衡量任务结果，`safety_checks` 单列安全回归。Skill Case 额外声明 `skill_id` 和 `should_trigger`；正例需要任务检查，负例可以只有触发检查。留出集必须声明脱敏和独立审核人。Suite、Subject 和 Runtime 以内容摘要固定，比较只接受同 Suite、同运行条件、同重复次数的 Run。

## Host 轨迹合同

运行命令可读取 `CRAFT_EVAL_RUN_ID`、`CRAFT_EVAL_TASK_RUN_ID`、`CRAFT_EVAL_CASE_ID`、`CRAFT_EVAL_TRIAL`、`CRAFT_EVAL_OUTPUT_DIR`、`CRAFT_EVAL_TRACE_PATH`。Agent/Skill 适配器将 JSONL 写入 `CRAFT_EVAL_TRACE_PATH`。每行至少有 `source: "host"`、本次 `task_run_id`、`event`。Skill 实际调用写 `{"event":"skill.invoked","skill_id":"..."}`；结束时写 `{"event":"run.finished"}`。缺少终态或轨迹无效，触发与轨迹检查为**未判定**；没有调用事件不能自动推断"未触发"。终态事件可包含非负的 `cost_units`；未提供时成本显示为未测量。

Agent 用例即使只检查输出文件，也必须有完整 Host 轨迹才能得到通过结论。

Skill 增益比较要求同一留出 Suite 至少 20 个不同正例、一个负例、独立 TaskRun、候选无触发错误和安全失败、任务配对有改善且单侧符号检验 `p ≤ 0.05`。返回 `skill_gain_supported` 仅表示这组任务上的证据支持改善，不授予发布权。任务、触发、安全、时延与成本分别报告。

符号检验要求用例彼此足够独立；反复调参或多候选筛选需要另留最终测试集，避免选择偏差。

## 运行边界

- 命令通过 argv 直接执行，没有 shell 展开。工作区逐任务复制，忽略 `.git`、`.craft_data`、`.venv`、`node_modules` 和 `__pycache__`，拒绝输入符号链接；检查器也拒绝通过输出符号链接读工作区外文件。
- **只运行受信任的命令与 Host 适配器。** 工作区复制并非操作系统沙箱，不能阻止命令访问网络或机器上其他路径。需要执行不受信任代码时，先在外部容器/虚拟机里运行本工具。
- 结果只保留检查结果、摘要和数值，不保存 stdout、stderr 或原始轨迹。输出目录不得位于输入工作区内。每项任务有独立目录与 TaskRun ID；计划数、已记录数、失败、未判定、无效和缺失数均在报告中列出。
- 本地测试验证了真实子进程与示例 Host 轨迹链路；尚未与 Codex、Claude 或 Craft 的实际 Host 事件源打通。接真实 Host 时，应由 Host 自身发出轨迹，避免让被测 Agent 自行声明成功。
- 在 Windows 上，目录链接（junction）无需开发者模式或管理员权限，文件符号链接则必须提权。拒绝规则覆盖两者：检查器逐级 `lstat`，任何链接（`isSymbolicLink()`）都按"路径穿越"拒绝，因此安全用例以 junction 驱动即可，不需要提权。

## 类型与模块

源码在 `src/`（`evaluation.ts` 为核心，`cli.ts` 为命令行，`index.ts` 为导出入口），编译产物在 `dist/`。`npm test` 先编译再运行 `dist/tests/*.test.ts` 对应的测试。
