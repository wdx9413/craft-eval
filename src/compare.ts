/**
 * Compare two `--report` artifacts from the held-out suite.
 *
 *   node --experimental-strip-types capability/craft-eval/compare.ts baseline.json candidate.json [--json]
 *
 * Exits 1 when the runs are not comparable or a previously passing case
 * regressed, so a candidate cannot be waved through by looking at one ledger.
 * `--json` prints one machine-readable object instead of the human table, so
 * CI can consume the verdict without scraping prose. Both modes keep the same
 * exit contract.
 */
import { readFileSync } from "node:fs";
import { compareRunReports } from "./compare-run-reports.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [baselinePath, candidatePath] = argv.filter((arg) => arg !== "--json");
if (!baselinePath || !candidatePath) throw new Error("usage: compare.ts <baseline.json> <candidate.json> [--json]");

const parse = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const comparison = compareRunReports(parse(baselinePath), parse(candidatePath));

if (json) {
  console.log(JSON.stringify(comparison));
} else {
console.log(`identity: ${comparison.identity.provider} ${comparison.identity.base_url} ${comparison.identity.model} ${comparison.identity.suite_digest.slice(0, 22)}... isolation=${comparison.identity.isolation}`);
if (comparison.suite_evolution) {
  console.log(`suite evolution: ${comparison.suite_digest_delta?.baseline.slice(0, 22)}... -> ${comparison.suite_digest_delta?.candidate.slice(0, 22)}... (comparison still valid over common cases)`);
}
console.log(`comparable: ${String(comparison.comparable)} — ${comparison.reason}`);
for (const ledger of comparison.ledgers) {
  console.log(`  ${ledger.ledger.padEnd(12)} ${String(ledger.baseline ?? "NO OBSERVATION").padEnd(16)} -> ${String(ledger.candidate ?? "NO OBSERVATION").padEnd(16)} (passed ${ledger.baselinePassed} -> ${ledger.candidatePassed}, delta ${ledger.passedDelta >= 0 ? "+" : ""}${ledger.passedDelta})`);
}
for (const [label, items] of [
  ["regressions", comparison.regressions], ["improvements", comparison.improvements],
  ["new cases", comparison.newCases], ["removed cases", comparison.removedCases],
] as const) {
  console.log(`${label}: ${items.length}${items.length ? ` — ${items.join(", ")}` : ""}`);
}
}
if (!comparison.comparable || comparison.regressions.length) process.exitCode = 1;
