import type { JsonObject } from 'craft-common-store-local/';
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

/**
 * G1: cross-trajectory abstraction.
 *
 * The gap this closes. Craft captured experience one trajectory at a time:
 * `decideExperienceCapture` scored a single run's outcome, retries and
 * corrections, and `buildExperienceRecord` produced one record per run. Nothing
 * ever looked *across* runs. So Craft had the Reflection stage of the memory
 * literature and none of the Experience stage — it could record that a run went
 * badly, but never that twelve runs went badly the *same* way.
 *
 * Why that matters more than it sounds: a per-run lesson is only useful to the
 * run that produced it. The value of memory is that the thirteenth attempt
 * starts smarter than the first. That requires generalising over trajectories,
 * which is exactly what was missing.
 *
 * The hard part is not clustering, it is *deserving* to generalise. An
 * over-eager abstraction is indistinguishable from a confident hallucination,
 * and it would poison every future run that trusts it. So the rules here are
 * deliberately strict:
 *
 *   1. Recurrence must be observed across trajectories that are **independent**
 *      — distinct traces, and for a stronger claim, distinct tasks. Three
 *      attempts at the same task in one trace is one story told three times.
 *   2. Generalisation happens over a **deterministic signature**, never over
 *      free text. The signature is derived from failure shape (which checks
 *      failed, how often, in what order), so two runs group together only when
 *      they failed the *same way* by a rule anyone can re-run.
 *   3. Below the evidence floor the function returns **no abstraction**, not a
 *      weaker one. "Not enough evidence" is a legitimate, expected answer.
 */

/** A single observed trajectory, reduced to the facts abstraction may use. */
export interface TrajectoryEvidence {
  trace_id: string;
  task_id: string;
  /** Deterministic failure signature, e.g. the sorted names of failed checks. */
  failure_signature: string;
  /** Failed check names, kept for the readable part of the abstraction. */
  failed_checks: string[];
  outcome: "succeeded" | "failed" | "abandoned";
  /** Monotonic time; used only to order trajectories, never to weight them. */
  observed_at: number;
}

export interface AbstractionCandidate {
  signature: string;
  /** Every trajectory that exhibited this signature, sorted for determinism. */
  trace_ids: string[];
  distinct_tasks: number;
  occurrences: number;
  failed_checks: string[];
  /** True when the evidence floor was met and the abstraction may be published. */
  publishable: boolean;
  /** Why it is or is not publishable, so a refusal is never silent. */
  reason: string;
}

/**
 * Evidence floor.
 *
 * Recurrence needs repetition AND spread. Repetition alone is not enough: the
 * same task retried twice inside one trace is one story told twice, not a
 * pattern, and treating it as one is how a broken loop convinces itself it has
 * learned something. So a signature must appear at least `MIN_OCCURRENCES` times
 * across at least `MIN_DISTINCT_TASKS` distinct tasks.
 */
const MIN_OCCURRENCES = 2;
const MIN_DISTINCT_TASKS = 2;

/**
 * A check name's stable part.
 *
 * Running this module against a real model exposed a contract hole: a check named
 * `rev-1:exact` and one named `rev-2:exact` are the same kind of failure, but as
 * raw strings they never match, so recurrence across tasks is invisible and the
 * evidence floor can never be met. The names are per-task by nature, so a caller
 * (the author included) easily defeats cross-task grouping without noticing.
 *
 * So the task-specific prefix is stripped and only the check's own identity
 * remains. Splitting on `:` is the convention the verification sensor already
 * uses for `case:check`, and a name with no separator is already task-free.
 */
function checkIdentity(name: string): string {
  const separator = name.lastIndexOf(":");
  const tail = separator >= 0 ? name.slice(separator + 1) : name;
  return tail.trim() || name.trim();
}

/**
 * Derive the deterministic failure signature for one trajectory.
 *
 * Two trajectories share a signature only when they failed the *same* checks,
 * judged by the check's own identity rather than the task that ran it. Sorting
 * makes the signature order-independent, so a run that failed its checks in a
 * different order still groups with its siblings — the failure is the set, not
 * the sequence.
 *
 * A trajectory that failed no check gets an empty signature and can never
 * contribute to an abstraction, because "succeeded" is not a lesson.
 */
export function trajectoryFailureSignature(input: JsonObject): string {
  const failed = Array.isArray(input.failed_checks) ? input.failed_checks.map((item) => text(item, "failed_checks")) : [];
  const unique = [...new Set(failed.map(checkIdentity))].sort();
  return unique.join("|");
}

/** Normalize one trajectory into the evidence abstraction is allowed to use. */
function normalize(input: JsonObject, index: number): TrajectoryEvidence {
  const traceId = text(input.trace_id, `trajectories[${index}].trace_id`);
  const taskId = text(input.task_id, `trajectories[${index}].task_id`);
  const outcome = text(input.outcome, `trajectories[${index}].outcome`);
  if (!["succeeded", "failed", "abandoned"].includes(outcome)) throw new Error(`trajectories[${index}].outcome is unsupported`);
  const observedAt = input.observed_at === undefined ? 0 : Number(input.observed_at);
  if (!Number.isFinite(observedAt)) throw new Error(`trajectories[${index}].observed_at must be a number`);
  const failedChecks = Array.isArray(input.failed_checks) ? input.failed_checks.map((item) => text(item, `trajectories[${index}].failed_checks`)) : [];
  const signature = input.failure_signature === undefined
    ? trajectoryFailureSignature({ failed_checks: failedChecks })
    : text(input.failure_signature, `trajectories[${index}].failure_signature`);
  // Stored normalized as well, so the readable statement names the kind of check
  // rather than whichever task happened to be first in the group.
  return { trace_id: traceId, task_id: taskId, failure_signature: signature, failed_checks: [...new Set(failedChecks.map(checkIdentity))].sort(), outcome: outcome as TrajectoryEvidence["outcome"], observed_at: observedAt };
}

/**
 * Group trajectories by failure signature and decide which groups deserve to
 * become an abstraction.
 *
 * Returns every group it found, each carrying its own `publishable` verdict and
 * the reason, so a caller can see the near-misses rather than only the winners.
 */
export function findRecurringFailures(input: JsonObject): JsonObject {
  const raw = input.trajectories;
  if (!Array.isArray(raw)) throw new Error("trajectories must be an array");
  const trajectories = raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`trajectories[${index}] must be an object`);
    return normalize(item as JsonObject, index);
  });
  // A duplicated trace id would let one run masquerade as recurrence, which is
  // the single most dangerous way this function could be fooled.
  const traceIds = trajectories.map((item) => item.trace_id);
  if (new Set(traceIds).size !== traceIds.length) throw new Error("trajectories must reference distinct traces");

  const groups = new Map<string, TrajectoryEvidence[]>();
  for (const trajectory of trajectories) {
    // A clean run teaches nothing about failure, so it never seeds a group.
    if (!trajectory.failure_signature) continue;
    const bucket = groups.get(trajectory.failure_signature) ?? [];
    bucket.push(trajectory);
    groups.set(trajectory.failure_signature, bucket);
  }

  const candidates: AbstractionCandidate[] = [...groups.entries()].map(([signature, members]) => {
    const ordered = [...members].sort((left, right) => left.observed_at - right.observed_at || left.trace_id.localeCompare(right.trace_id));
    const distinctTasks = new Set(ordered.map((item) => item.task_id)).size;
    const occurrences = ordered.length;
    const enoughOccurrences = occurrences >= MIN_OCCURRENCES;
    const enoughTasks = distinctTasks >= MIN_DISTINCT_TASKS;
    // Both must hold: repetition without spread can be one broken loop retrying
    // itself, so a same-task retry never becomes a generalisation.
    const publishable = enoughOccurrences && enoughTasks;
    return {
      signature,
      trace_ids: ordered.map((item) => item.trace_id),
      distinct_tasks: distinctTasks,
      occurrences,
      failed_checks: ordered[0]!.failed_checks,
      publishable,
      reason: publishable ? "recurrence_observed" : enoughOccurrences ? "single_task_recurrence" : "insufficient_occurrences"
    };
  }).sort((left, right) => right.occurrences - left.occurrences || left.signature.localeCompare(right.signature));

  return {
    candidates,
    publishable_count: candidates.filter((candidate) => candidate.publishable).length,
    // Reported explicitly so "we found nothing" is distinguishable from "we
    // were not given enough to look at".
    considered: trajectories.length,
    observed: candidates.reduce((sum, candidate) => sum + candidate.occurrences, 0)
  };
}

/**
 * Build the abstraction for one recurring failure.
 *
 * The output is a *candidate*, never a published lesson: it carries the exact
 * trajectories that justify it, and `requires_review` is always true. An
 * abstraction is a claim about the future drawn from the past, and the whole
 * point of Craft's governance is that such a claim is proposed, not asserted.
 */
export function buildAbstraction(input: JsonObject): JsonObject {
  const analysis = findRecurringFailures(input);
  const signature = text(input.signature, "signature");
  const candidate = (analysis.candidates as AbstractionCandidate[]).find((item) => item.signature === signature);
  if (!candidate) throw new Error("No trajectories exhibit that failure signature");
  if (!candidate.publishable) throw new Error(`Abstraction is not supported by enough independent trajectories: ${candidate.reason}`);

  const checks = candidate.failed_checks;
  const scope = input.scope === undefined ? "project" : text(input.scope, "scope");
  // The statement is generated from the evidence, so it cannot overclaim: it
  // names the exact checks and the exact number of independent observations.
  const statement = checks.length
    ? `${checks.join(", ")} failed across ${candidate.occurrences} independent trajectories spanning ${candidate.distinct_tasks} task(s)`
    : `An unnamed failure recurred across ${candidate.occurrences} independent trajectories`;

  return {
    abstraction_id: String(input.abstraction_id ?? `abstraction_${digestJson({ signature, trace_ids: candidate.trace_ids }).slice(-24)}`),
    kind: "recurring_failure",
    scope,
    signature,
    statement,
    failed_checks: checks,
    // Provenance is what separates a generalisation from a guess: every claim
    // here can be re-derived from these exact traces.
    evidence: {
      trace_ids: candidate.trace_ids,
      occurrences: candidate.occurrences,
      distinct_tasks: candidate.distinct_tasks,
      source: "cross_trajectory_abstraction"
    },
    // An abstraction about failure always describes something that went wrong.
    requires_review: true,
    // Deliberately unchanged from the per-run path: generalising is not
    // authority to act.
    execution_authority: false,
    confidence: candidate.distinct_tasks >= 3 ? "high" : "moderate"
  };
}

/**
 * The full pass: find every recurring failure and build the abstractions that
 * clear the evidence floor.
 *
 * `rejected` is returned alongside `abstractions` so a run that produced
 * nothing still shows what it nearly found, which is what makes the abstention
 * checkable rather than trust-based.
 */
export function abstractAcrossTrajectories(input: JsonObject): JsonObject {
  const analysis = findRecurringFailures(input);
  const scope = input.scope === undefined ? "project" : text(input.scope, "scope");
  const abstracted: JsonObject[] = [];
  const rejected: JsonObject[] = [];
  for (const candidate of analysis.candidates as AbstractionCandidate[]) {
    if (!candidate.publishable) { rejected.push({ signature: candidate.signature, reason: candidate.reason, occurrences: candidate.occurrences, distinct_tasks: candidate.distinct_tasks }); continue; }
    abstracted.push(buildAbstraction({ trajectories: input.trajectories, signature: candidate.signature, scope }));
  }
  return {
    abstractions: abstracted,
    rejected,
    abstraction_count: abstracted.length,
    considered: analysis.considered,
    // Stated in the result so a consumer never has to infer whether silence
    // meant "nothing recurred" or "nothing was examined".
    sufficient_evidence: abstracted.length > 0
  };
}
