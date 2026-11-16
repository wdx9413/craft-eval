# P0 设计与验收：模型判断端到端

## 问题

`model_graded` 与 `calibrate` 的管线已经存在，但没有可复现的金集、没有真实 judge 示例，也没有把"校准通过"变成使用 judge 的前置条件。结果是：能跑，但不能证明"这个 judge 可信"。

## 设计

### 金集目录

```text
examples/judge-pool/
  v1/
    samples.json         # 样本清单（含 provenance）
    answers/             # 每个样本的答案文本
    manifest.json        # 指向 samples.json 的 calibration manifest
```

`samples.json` 每项：

```json
{ "id": "numeric-391", "answer": "answers/numeric-391.txt", "expected": "passed", "threshold": 0.8, "provenance": { "source": "examples/cases.ts#ARITHMETIC" } }
```

金集要求：≥10 样本；至少 3 正、3 负；至少 2 个边界（空输出、超长输出或格式错误）。

### 真实 judge 示例

`examples/judge-workspace/` 保留规则式 stub（离线验证管线），另提供 `judge-http.mjs`：用环境变量 `CRAFT_EVAL_JUDGE_ENDPOINT` / `CRAFT_EVAL_JUDGE_MODEL` / `CRAFT_EVAL_JUDGE_API_KEY_ENV` 调用 OpenAI-compatible 网关，把 rubric 与答案发给模型，解析返回中的分数。

- 缺任一环境变量时以非零退出并说明缺失项 → 记为环境缺失，不产生假分数。
- 提示词明确要求只输出 JSON，且对模型返回做严格解析（无分数 → 判分错误）。

### 校准门槛

新增可选 manifest 字段：

```json
{ "minimum_accuracy": 0.8, "minimum_consistency": 0.9 }
```

`calibrate` 输出 `passed: boolean`（accuracy/consistency 均达到门槛）；未达标时 CLI 退出码 1。未声明门槛时保持现状（只报告不判定）。

### 与评测的关系

`model_graded` check 可声明 `judge_calibrated: { "manifest": "path", "minimum_accuracy": 0.8 }`：

- 评测开始前先跑校准；未达标则该 check 记 `judge_uncalibrated`（`inconclusive`），不把不可信的 judge 当作失败。
- 校准结果写入 `results[].checks[].evidence.calibration`（accuracy/consistency/manifest digest）。

## 验收清单

- [x] `examples/judge-pool/v1/` 金集（≥10 样本，含 provenance）。
- [x] `calibrate` 支持 `minimum_accuracy` / `minimum_consistency` 并输出 `passed`，未达标退出 1。
- [x] 规则式 stub 在金集上得到 `accuracy = 1`；故意写坏的 judge（恒 1.0）得到 `accuracy < 1`。
- [x] `judge-http.mjs` 在缺环境变量时明确报缺失项且不产生分数。
- [x] `model_graded.judge_calibrated` 实现：达标 → 正常判分；未达标 → `judge_uncalibrated`。
- [x] 测试 ≥10 个（校准门槛、缺环境、坏 judge、未校准 check）。

## 非目标

- 不在 craft-eval 内引入模型 SDK 或内置默认模型。
- 不自动挑选阈值；阈值由金集作者声明。

## 真实运行记录

- 规则式金集：`examples/judge-pool/v1/manifest.json` 在 10 样本上 accuracy=1 / consistency=1 / errors=0。
- 真实模型金集：`examples/judge-pool/v1/manifest-http.json` 经本地 `group/free` 网关实测 accuracy=1 / consistency=1 / errors=0；rubric 修复了把超卖正例写成"通过"和空输出/超长输出的语义反转。
- 真实模型端到端：`examples/judge-pool/v1/suite-http.json` 经 `judge_env` 转发网关凭证，run 实测 passed 1/1，judge 证据带模型分数与理由。

