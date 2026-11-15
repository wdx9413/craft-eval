# P2 设计与验收：证据自动保留与 flaky 检测

## 问题

1. 失败用例默认丢弃 stdout/stderr/轨迹/产物，事后无法 `rescore`、无法复核，只能重跑（真实代价：金融 MCP 单 case 约 2 分钟）。
2. `trials` 支持多轮，但同一 case 在 3 轮里 2 过 1 挂时，报告只显示 `2 passed 1 failed`，没有"这个用例不稳定"的结论；下游可能把它当成稳定增益证据。

## 设计

### `--keep-traces` 扩展

| 取值 | 行为 |
|---|---|
| `never`（默认） | 只留摘要哈希 |
| `on-failure` | 仅对 verdict ∈ {failed, inconclusive, invalid, not_applicable} 的 (case, trial) 落盘 |
| `always` | 全部落盘（等价于旧布尔 `true`） |

兼容：CLI 旧写法 `--keep-traces` 等价 `always`；`RunOptions.keep_traces?: boolean | 'never' | 'on-failure' | 'always'`。

落盘路径不变：`<run_dir>/captures/<case_id>-<trial>/{stdout,stderr,host-trace,gateway-trace,outputs/}`。

`plan.json.execution_controls.keep_traces` 记录实际取值（字符串），旧 run 的布尔值读回时映射为 `always`/`never`。

### flaky 判定

一个 case 在 `trials >= 2` 时，若其 verdict 集合同时包含 `passed` 与任一非 passed，则标记 flaky。

`report` 新增：

```json
{
  "flaky_cases": [
    { "case_id": "flaky-search", "verdicts": { "passed": 2, "failed": 1 }, "trials": 3 }
  ]
}
```

`analyze` 新增分类 `flaky`：每个 flaky case 一条，`evidence` 给出各 verdict 计数。

`compareRuns` 规则：

- 若 suite 的 `trials > 1` 且存在 flaky case，则这些 case 不进入配对样本（`unmeasured` +1），并在 `flaky_excluded` 列出。
- `skill_gain_supported` 额外要求 `flaky_excluded` 为空。

### 证据完整性

`rescore` 遇到 `on-failure` 保留的 run 时：

- passed 的 case 没有 captures → 不能重打分，结果标记 `not_rescorable: no_captures`，不静默复制旧结论。

## 验收清单

- [ ] `keep_traces` 三取值解析、执行、写入 `execution_controls`、旧布尔值兼容。
- [ ] `on-failure` 下 passed case 无 captures 目录、failed case 有。
- [ ] `report.flaky_cases` 计算（稳定通过/稳定失败/2 过 1 挂/单 trial 四组）。
- [ ] `analyze` 的 `flaky` 分类。
- [ ] `compareRuns` 排除 flaky 并影响 `skill_gain_supported`。
- [ ] `rescore` 在无 captures 时输出 `not_rescorable` 而不是假结论。
- [ ] 测试 ≥8 个，覆盖上述组合。

## 非目标

- 不自动重试；重试仍由 `experiment.retry` 显式声明。
- 不把 flaky 当失败；它是"证据不稳定"，单独报告。
