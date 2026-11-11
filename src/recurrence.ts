/**
 * Third evaluation run: force genuine, repeated failure to verify the full loop.
 *
 * The previous run showed the normalization working (`signature: "exact"`), but
 * the model got two of three reverses right, so refusing to generalise was the
 * correct outcome rather than a demonstration.
 *
 * This run uses a task the model reliably fails — exact character counting, which
 * it cannot verify internally — across three independent tasks, so recurrence is
 * real and the abstraction path is genuinely exercised. The difficulty is not
 * planted: the expected values are correct and the model's answers are wrong.
 *
 * Run with `WORKBUDDY_API_KEY` set:
 *   node --experimental-strip-types eval/recurrence.ts
 */
import { abstractAcrossTrajectories } from "./trajectory-abstraction.ts";
import { summarizeAttributions } from "./failure-attribution.ts";
import { evaluateVerificationCheck } from "./verification-sensor.ts";
import { ask, requireEvaluationCredential } from "./model.ts";
import { COUNTING_TASKS } from "./cases.ts";

// Before any case: a missing credential must not be graded as a wrong answer.
requireEvaluationCredential();

const trajectories: Array<Record<string, unknown>> = [];
const failures: Array<Record<string, unknown>> = [];

for (const [index, testCase] of COUNTING_TASKS.entries()) {
  let answer = "";
  // The answer is a single number, but a reasoning model spends part of the
  // budget before emitting it, so the shared default is used.
  try { answer = await ask(testCase.prompt); } catch (error) { answer = `ERROR ${(error as Error).message}`; }
  const check = evaluateVerificationCheck({ kind: "output_contains", name: `${testCase.id}:exact_count`, expected_substring: testCase.expected, observed_output: answer });
  const ok = check.verdict === "passed";
  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.id.padEnd(8)} got=${JSON.stringify(answer)} want=${JSON.stringify(testCase.expected)}`);
  trajectories.push({
    trace_id: `trace_${testCase.id}`, task_id: testCase.id,
    failed_checks: ok ? [] : [`${testCase.id}:exact_count`],
    outcome: ok ? "succeeded" : "failed", observed_at: index,
  });
  // The raw observation, not a pre-computed attribution: `summarizeAttributions`
  // takes observations and decides the classes itself.
  if (!ok) failures.push({ answer_wrong_with_full_context: true });
}

const report = abstractAcrossTrajectories({ trajectories, scope: "project" });
console.log(`\nabstractions: ${String(report.abstraction_count)}  sufficient_evidence=${String(report.sufficient_evidence)}`);
console.log(`abstractions:\n${JSON.stringify(report.abstractions, null, 1)}`);
console.log(`rejected:\n${JSON.stringify(report.rejected, null, 1)}`);

if (failures.length) {
  console.log(`\nattribution summary:\n${JSON.stringify(summarizeAttributions({ failures }), null, 1)}`);
}
