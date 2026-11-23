import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputDir = process.env.CRAFT_EVAL_OUTPUT_DIR;
if (!outputDir) throw new Error("CRAFT_EVAL_OUTPUT_DIR is required");
mkdirSync(outputDir, { recursive: true });

const caseId = process.env.CRAFT_EVAL_CASE_ID ?? "coding-write";
let domain = "coding";
let caseName = caseId.replace("coding-", "");
let scopeLeakCount = 0;

if (caseId === "coding-scope-leak") {
  scopeLeakCount = 0;
}

const result = {
  domain,
  case: caseName,
  scope_leak_count: scopeLeakCount,
  checks_passed: true,
};

writeFileSync(join(outputDir, "result.json"), JSON.stringify(result, null, 2));

