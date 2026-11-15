# craft-eval 运行手册

面向"要跑一次真实评测并给出可信结论"的操作者。每一步都给出命令与失败排查。

## 1. 前置检查

```bash
node --version          # 需要 >= 22
npm install             # 仅构建期依赖
npm run build
```

若被测对象是第三方仓库，先确认它已克隆到 `eval-subjects/<name>`（或通过 `CRAFT_EVAL_SUBJECTS_ROOT` 指向实际位置），并完成其自身依赖安装。

环境门控会在用例执行前检查 `requires`（`commands` / `env` / `python_modules` / `paths` / `symlink` / `network_loopback`）。不满足的用例记为 `not_applicable`，**不是失败**；先看 `report.not_applicable` 再判断覆盖率。

## 2. 跑一次评测

```bash
node dist/src/cli.js validate <suite.json>
node dist/src/cli.js audit    <suite.json>          # 质量门：有 error 级 finding 时退出码 1
node dist/src/cli.js coverage <suite.json>          # 维度覆盖 + gaps
node dist/src/cli.js run <suite.json> <subject.json> <runtime.json> \
  --workspace <dir> --output <runs-dir> --keep-traces --fail-on-failed
```

- `--keep-traces` 保留每 case 的 stdout/stderr、host/gateway 轨迹与 `outputs/`；排查失败时必须开。
- `--fail-on-failed` 让 CI 在出现 failed/inconclusive/invalid/missing 时退出 1，同时仍输出完整 JSON。
- 结果在 `<runs-dir>/<run-id>/`：`plan.json`（执行条件、subject digest、execution_controls）+ `results/<case>-<trial>.json`。

## 3. 看结论

```bash
node dist/src/cli.js report     <run-dir>
node dist/src/cli.js analyze    <run-dir>            # 失败分类、聚类、最慢/最贵
node dist/src/cli.js report-html <run-dir> --output report.html
```

读报告的顺序建议：

1. `status`（complete / incomplete）与 `not_applicable` — 先确认这次跑的条件够不够。
2. `by_language` — 发现单语言退化（例如某语言全部 failed）。
3. `analyze` 的 clusters — 按失败类别分派，而不是逐条看。
4. `hotspots` — 最慢/最贵的 case，决定优化优先级。

## 4. 比较两个版本

```bash
node dist/src/cli.js compare <baseline-run> <candidate-run> [--require-gain]
```

- 只有相同 suite digest、相同 runtime、相同 trials、相同 subject_kind 才可比，否则报错。
- `--require-gain` 在 `skill_gain_supported !== true` 时退出 1。
- `skill_gain_supported` 需要：留出集、≥20 正例、≥1 负例、独立 TaskRun、全部触发证据为 gateway、无触发/安全失败、配对胜、单侧 `p ≤ 0.05`。

## 5. 改判分器后重新判分

```bash
node dist/src/cli.js rescore <run-dir> --workspace <dir> --output <new-runs-dir>
```

只重跑 `script` 检查，不启动 Host、不重跑被测对象。前提是原 run 用了 `--keep-traces`。`trace_event` / `tool_call` 的 gateway 证据不会从磁盘回读，这是刻意的安全边界。

## 6. 模型判断（judge）

```bash
node dist/src/cli.js calibrate <judge-manifest.json> [--timeout-ms N] [--max-output-bytes N]
```

- judge 命令通过 `CRAFT_EVAL_JUDGE_ANSWER` 与 `CRAFT_EVAL_JUDGE_RUBRIC` 接收输入，必须打印 `{"score": 0..1, "reason": "..."}`。
- 先看 `accuracy`（对金集一致率）与 `consistency`（重复打分自一致率）；`accuracy` 低于预期时先改 judge 或阈值，不要直接用于评测。
- judge 超时/非零退出/输出非法 → `judge_error`，用例判为 `inconclusive`，**不当作低分**。

## 7. 变异测试（充分性论证）

```bash
node dist/src/cli.js mutation <manifest.json> <suite.json> <runtime.json> --workspace <dir> --output <dir>
```

- manifest 的 `baseline_dir` / `subject_path` 相对 manifest 目录解析；`subject_env` 里可用 `{{copy}}` 指向变异副本。
- `mutation_score` 抓不到的缺陷 = 用例盲区，应回流为新用例，而不是下调阈值。
- `mutation_score = 1` 只说明"声明的缺陷都被抓到"，不证明评测完备。

## 8. 常见失败与处理

| 现象 | 常见原因 | 处理 |
|---|---|---|
| `not_applicable` 增多 | 缺命令/包/路径/symlink 权限 | 看 `issue: requirement_unmet:<tag>`，补齐环境；不要改判分 |
| `invalid` + `adapter_error:FileNotFoundError` | 命令不在 PATH，或 Windows 上是 `.cmd` shim | 用绝对路径，或依赖内置 shim 解析 |
| `inconclusive` + `timeout` | 用例超时 | 提高 `timeout_s` 或拆分用例 |
| `judge_error` | judge 崩溃/输出非 JSON/超限 | 单独跑 judge 命令复现；必要时提高 `--max-output-bytes` |
| 全量测试出现单文件通过、分组失败 | 被测项目存在跨用例状态污染 | 记录为被测项目缺陷，不要放宽判分 |
| suite digest 变化导致 compare 报错 | suite 内容变了 | 用同一 suite 重跑 baseline；或接受"不可比" |

## 9. 证据位置速查

| 需要看什么 | 位置 |
|---|---|
| 执行条件（并发、workspace 模式、keep_traces、输出上限） | `<run-dir>/plan.json` → `execution_controls` |
| 每个 case 的检查与证据 | `<run-dir>/results/<case>-<trial>.json` → `checks[].evidence` |
| 原始 stdout/stderr/轨迹/产物 | `<run-dir>/captures/<case>-<trial>/`（需 `--keep-traces`） |
| 脚本判分失败原因 | `checks[].evidence.stderr_tail` / `stdout_tail` |
| 模型判断分数与理由 | `checks[].evidence.score` / `judge_reason` / `judge_stderr_tail` |
| 契约与质量规则 | `README.md`、`docs/roadmap-to-ideal-state.md`、`docs/ownership-boundary.md` |
