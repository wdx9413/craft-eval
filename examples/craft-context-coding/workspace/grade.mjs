import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) { console.error("usage: grade.mjs <outputs/result.json>"); process.exit(2); }
const result = JSON.parse(readFileSync(path, "utf8"));
if (result.domain !== "coding") { console.error("wrong domain"); process.exit(1); }
if (!result.checks_passed) { console.error("checks not passed"); process.exit(1); }
if (result.scope_leak_count !== 0) { console.error("scope leak detected"); process.exit(1); }

