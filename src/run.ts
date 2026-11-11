/**
 * A real evaluation run against the live local model.
 *
 * This exercises the closed learning loop end to end rather than echoing text:
 * the model is asked to produce artifacts, v0.12.37 grades them deterministically
 * from observed bytes, v0.12.38 attributes any failure, and v0.12.34 decides
 * whether the outcome is worth capturing as a lesson.
 *
 * Nothing here asks the model whether it succeeded — that is the whole point.
 *
 * Run with `WORKBUDDY_API_KEY` set:
 *   node --experimental-strip-types eval/run.ts
 */
import { decideExperienceCapture } from "./context-retrieval-capture.ts";
import { evaluateVerificationCheck, summarizeVerification, verificationCaptureSignals } from "./verification-sensor.ts";
import { attributeFailure } from "./failure-attribution.ts";
import { ask, EVAL_MODEL, requireEvaluationCredential } from "./model.ts";
import { DETERMINISTIC_TASKS } from "./cases.ts";

// Before any case: a missing credential must not be graded as a wrong answer.
requireEvaluationCredential();

const trajectories: JsonObject_[] = [];
interface JsonObject_ { [key: string]: unknown }
let passed = 0;

for (const testCase of DETERMINISTIC_TASKS) {
  const started = Date.now();
  let answer = "";
  let errored: string | null = null;
  try {
    answer = await ask(testCase.prompt);
  } catch (error) {
    errored = (error as Error).message;
  }

  // Deterministic grading over observed bytes. `output_contains` is used with an
  // exact expected string, so no model judgement enters the verdict.
  const exact = evaluateVerificationCheck({
    kind: "output_contains", name: `${testCase.id}:exact`,
    expected_substring: testCase.expected, observed_output: errored ?? answer,
  });
  const summary = summarizeVerification([exact]);
  const ok = summary.verdict === "passed";
  if (ok) passed += 1;

  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.id.padEnd(11)} got=${JSON.stringify(answer).slice(0, 40)} want=${JSON.stringify(testCase.expected)}`);

  // The observed outcome, not a self-report, drives the rest of the loop.
  const signals = verificationCaptureSignals({ checks: [{ kind: "output_contains", name: testCase.id, expected_substring: testCase.expected, observed_output: errored ?? answer }] });
  const attribution = ok ? null : attributeFailure({ answer_wrong_with_full_context: true });
  const decision = decideExperienceCapture({ ...signals, summary: `case ${testCase.id}`, task_id: testCase.id });

  trajectories.push({
    trace_id: `trace_${testCase.id}`, task_id: testCase.id,
    failed_checks: ok ? [] : [`${testCase.id}:exact`],
    outcome: signals.outcome as string, observed_at: started,
    captured: decision.capture, kind: decision.kind, attributed: attribution?.failure_class ?? null,
  });
}

console.log(`\nscore: ${passed}/${DETERMINISTIC_TASKS.length}`);
console.log(`model: ${EVAL_MODEL}`);

const failures = trajectories.filter((item) => item.outcome !== "succeeded").length;
console.log(`observed failures: ${failures}`);
console.log(`captured lessons: ${trajectories.filter((item) => item.captured === true).length}`);

// Feed the observed trajectories into the abstraction pass: it decides for
// itself whether anything recurred enough to generalise.
const { abstractAcrossTrajectories } = await import("./trajectory-abstraction.ts");
const abstraction = abstractAcrossTrajectories({ trajectories, scope: "project" });
console.log(`abstractions: ${String(abstraction.abstraction_count)} sufficient_evidence=${String(abstraction.sufficient_evidence)}`);
console.log(`trajectories:\n${JSON.stringify(trajectories, null, 1)}`);
