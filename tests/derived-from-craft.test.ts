import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * craft-eval 的若干模块是 craft 内核同名模块的派生副本（只允许 import 路径不同）。
 * 这个测试防止两边逻辑漂移：差异行数一旦超出「import 适配」的预算就失败，
 * 提醒同步或改为从 craft-common 复用。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRAFT_CORE = join(ROOT, "craft", "core");
const EVAL_SRC = join(ROOT, "craft-eval", "src");

const DERIVED = [
  { name: "eval-cases", budget: 2 },
  { name: "eval-suite", budget: 2 },
  { name: "verification-sensor", budget: 2 },
  { name: "compaction", budget: 1 },
  { name: "token-budget", budget: 1 },
  { name: "model-gateway", budget: 5 },
  { name: "model-egress-security", budget: 3 },
  { name: "governance-pinning", budget: 2 },
  { name: "context-retrieval-capture", budget: 3 },
  { name: "trajectory-abstraction", budget: 2 },
  { name: "failure-attribution", budget: 2 },
];

test("craft-eval 派生模块与 craft 内核的差异不超过 import 适配预算", () => {
  for (const { name, budget } of DERIVED) {
    const upstream = join(CRAFT_CORE, `${name}.ts`);
    const derived = join(EVAL_SRC, `${name}.ts`);
    if (!existsSync(upstream) || !existsSync(derived)) continue;
    const left = readFileSync(upstream, "utf8").split(/\r?\n/u);
    const right = readFileSync(derived, "utf8").split(/\r?\n/u);
    let differing = 0;
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if (left[index] !== right[index]) differing += 1;
    }
    assert.ok(differing <= budget,
      `${name}.ts drifted: ${differing} differing lines (budget ${budget}); sync from craft/core or reuse craft-common`);
  }
});
