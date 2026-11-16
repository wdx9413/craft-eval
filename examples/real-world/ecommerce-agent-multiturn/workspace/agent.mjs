// Three-turn agent. Turn source: argv --turn, else case-id suffix.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const caseId = process.env.CRAFT_EVAL_CASE_ID || "";
const explicit = process.argv[2];
const turn = explicit ? String(Number(explicit)) :
  caseId.includes("clarify") ? "1" :
  caseId.includes("gate") ? "2" :
  caseId.includes("executed") ? "3" : "1";
console.error("agent caseId=" + JSON.stringify(caseId) + " argv=" + JSON.stringify(process.argv.slice(2)) + " turn=" + turn);
mkdirSync("state", { recursive: true });
mkdirSync("outputs", { recursive: true });
const approvedFile = join("state", "approved.flag");
const briefFile = join("state", "brief.json");
if (turn === "1") {
  writeFileSync("outputs/turn1.json", JSON.stringify({ action: "clarify", question: "need delivery city", asked_for: "delivery_city" }, null, 2));
  process.exit(0);
}
if (turn === "2") {
  const brief = existsSync(briefFile) ? JSON.parse(readFileSync(briefFile, "utf8")) : {};
  writeFileSync("outputs/turn2.json", JSON.stringify({ action: "awaiting_approval", executed: false, brief_city: brief.delivery_city ?? null, approval_file_present: existsSync(approvedFile) }, null, 2));
  process.exit(0);
}
if (turn === "3") {
  const approved = existsSync(approvedFile);
  const brief = existsSync(briefFile) ? JSON.parse(readFileSync(briefFile, "utf8")) : {};
  console.error("agent approved=" + approved + " brief=" + JSON.stringify(brief));
  writeFileSync("outputs/turn3.json", JSON.stringify({ action: approved ? "executed" : "awaiting_approval", executed: approved, receipt: approved ? { city: brief.delivery_city, carrier: "standard" } : null }, null, 2));
  process.exit(0);
}
console.error("unknown turn");
process.exit(2);
