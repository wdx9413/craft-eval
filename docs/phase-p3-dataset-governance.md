# P3 设计与验收：数据集版本谱系与污染溯源

## 问题

`audit` 能发现"开发集 prompt 原样出现在留出集"，但回答不了：

- 这个 suite 上一版是什么？哪些用例是这一版新增的？
- 两个用例是不是"换了措辞的同一道题"（近似重复）？
- 跨分区的污染是不是来自同一个 `provenance.source`？

## 设计

### 版本谱系

Suite 可选字段：

```json
{ "version": "2.1.0", "parent_digest": "sha256:..." }
```

- `version`：语义版本字符串（`X.Y.Z`）。
- `parent_digest`：上一版 suite 的 `digest(suite)` 值。

`audit` 新增：

| code | 级别 | 条件 |
|---|---|---|
| `suite_parent_unresolved` | warning | 声明了 `parent_digest` 但本次 audit 输入中没有该 digest 的 suite |
| `suite_parent_cycle` | error | 两个 suite 互相作为 parent |
| `suite_version_unchanged` | warning | `parent_digest` 存在但 `digest` 与父版本相同（声明了新版却未改动） |

输出新增 `suite_lineage`：每个 suite 的 `{ suite_id, version, digest, parent_digest }`，并按 parent 关系排序（未知 parent 放首位）。

### `craft-eval diff`

```bash
craft-eval diff <old-suite> <new-suite>
```

输出：

```json
{
  "schema": "craft-eval.suite-diff.v1",
  "added": ["case-3"],
  "removed": ["case-1"],
  "modified": [{ "case_id": "case-2", "before": "sha256:...", "after": "sha256:..." }],
  "parent_matches": true
}
```

`modified` 依据 `Case` 的规范化内容 digest（与 `audit.content_digest` 同源）。`parent_matches` 校验 `new.parent_digest === digest(old)`。

### 近似重复

规范化：NFKC + 小写 + 折叠空白（复用 `audit.normalizedText`）。

shingle：字符级 5-gram 集合；相似度 = Jaccard。

阈值默认 0.9，可通过 `audit --near-duplicate-threshold N` 调整（0..1）。

新增 finding `near_duplicate_prompt`（warning）：`message` 给出两侧 case id 与相似度；`case_ids` 同时包含两者。只在长度 ≥ 64 字符的 prompt 上执行，避免短题误报。

### 跨分区同源

新增 finding `shared_source_cross_partition`（warning）：同一 `provenance.source` 同时出现在 `development` 与 `held_out`，`case_ids` 列出双方。

`sanitized: true` 不豁免此检查——脱敏不等于独立。

## 验收清单

- [x] `Suite.version` / `parent_digest` 校验（格式、自引用、循环）。
- [x] `audit.suite_lineage` 输出与三种 finding。
- [x] `diff` 命令（added / removed / modified / parent_matches）。
- [x] `near_duplicate_prompt`（0.95 命中、0.85 不命中、短文本跳过）。
- [x] `shared_source_cross_partition`。
- [x] 测试 ≥10 个。

## 非目标

- 不做语义向量相似度（需引入模型/依赖）。
- 不声称能证明"未污染"，只报告可观测的重复与同源。

## 真实运行记录

- `diff <old> <new>` 输出 added / removed / modified 与 `parent_matches`；`audit` 输出 `suite_lineage` 并检出 self-parent、parent cycle、version-unchanged 三类 finding。
- 近似重复（5-gram Jaccard，默认 0.9）与跨分区同源污染 `shared_source_cross_partition` 在 `tests/near-duplicate.test.ts` / `tests/suite-lineage.test.ts` 中实测。

