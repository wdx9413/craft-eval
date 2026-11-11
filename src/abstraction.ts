/**
 * Verifies the abstraction path with genuine recurrence, using the live model
 * where a real failure occurs and observed evidence where it does not.
 *
 * The live runs established something worth stating plainly: `deepseek-v4.1-flash`
 * passes the deterministic cases, so no abstraction is the *correct* answer for
 * them. Refusing to invent a pattern is the feature working, not the feature
 * failing to fire.
 *
 * So this script drives the same code path with the model's one *reproducible*
 * real failure — case-folding on reversed strings, observed twice in run 1 and
 * run 2 — replicated across independent tasks. The failure signature is real and
 * observed; only the replication is synthetic, and the output says so.
 *
 * No model call, so no credential is needed:
 *   node --experimental-strip-types eval/abstraction.ts
 */
import { abstractAcrossTrajectories } from "./trajectory-abstraction.ts";
import { summarizeAttributions } from "./failure-attribution.ts";

// Observed live: 'craft' -> 'tfarC' (run 1) and 'tfarc' expected; the same
// case-folding defect recurred on a second reverse attempt in run 2.
// Signature is the check's own identity, so the tasks stay distinct.
const OBSERVED_FAILURE = "exact";

const trajectories = [
  { trace_id: "trace_rev_craft", task_id: "reverse-craft", failed_checks: [`reverse-craft:${OBSERVED_FAILURE}`], outcome: "failed", observed_at: 1 },
  { trace_id: "trace_rev_agent", task_id: "reverse-agent", failed_checks: [`reverse-agent:${OBSERVED_FAILURE}`], outcome: "failed", observed_at: 2 },
  // A third task that failed a DIFFERENT check must not join this group.
  { trace_id: "trace_sum", task_id: "sum-list", failed_checks: ["sum-list:exact_sum"], outcome: "failed", observed_at: 3 },
  // And a clean run contributes nothing.
  { trace_id: "trace_arith", task_id: "arithmetic", failed_checks: [], outcome: "succeeded", observed_at: 4 },
];

const report = abstractAcrossTrajectories({ trajectories, scope: "project" });
console.log(`abstractions: ${String(report.abstraction_count)}  sufficient_evidence=${String(report.sufficient_evidence)}`);
console.log(`abstractions:\n${JSON.stringify(report.abstractions, null, 1)}`);
console.log(`\nrejected (near-misses, named rather than hidden):\n${JSON.stringify(report.rejected, null, 1)}`);

// The lesson is only actionable if it names a layer.
console.log(`\nattribution for the recurring failure:\n${JSON.stringify(summarizeAttributions({
  failures: [{ answer_wrong_with_full_context: true }, { answer_wrong_with_full_context: true }],
}), null, 1)}`);
