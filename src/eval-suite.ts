import { createHash } from "node:crypto";
import type { JsonObject } from '../../craft-common/packages/craft-common-store-local/src/store.ts';
import { digestJson } from "./digest.ts";

/**
 * A held-out evaluation suite over Craft's own sub-capabilities.
 *
 * Why this exists as a kernel rather than a script. The project already has
 * `delivery_evaluation_case` with a `held_out` partition and a sanitized
 * requirement, and `EvalCampaignKernel` over it — but that campaign is built for
 * A/B comparison of two harnesses, so it needs a baseline and a candidate arm and
 * cannot answer "how good is this build on its own". Inventing a second
 * incompatible mechanism would repeat the mistake this codebase keeps catching,
 * so this reuses the same *contract* (held-out, sanitized, independently
 * approved, content-addressed, no promotion authority) for absolute
 * measurement.
 *
 * Three rules make the numbers mean something:
 *
 * 1. **Deterministic grading only.** Every case is decided from bytes by the
 *    v0.12.36 sensor vocabulary. A model judging its own output, or an LLM
 *    judge, is not reproducible and would make a score unfalsifiable.
 * 2. **`inconclusive` is never a pass.** A case that could not be observed is
 *    reported separately and excluded from the numerator, the same discipline
 *    the verification sensor applies to `blocked`.
 * 3. **The sample size travels with every rate.** `3/4` is not "75% ability";
 *    it is four observations. The summary always carries `total`, so a rate can
 *    never be quoted without its denominator.
 */

/** The sub-capability a case measures. */
export const CAPABILITY_AXES = ["memory", "knowledge", "workflow", "datasec", "experience_dedup", "knowledge_lineage", "eval_governance", "governance", "end_to_end", "context_supply", "proactive_restraint", "lifecycle", "domain_isolation", "plugin_contribution", "pilot_boundary", "external_sync", "runtime_dependency", "message_source"] as const;
export type CapabilityAxis = typeof CAPABILITY_AXES[number];

/**
 * The ledgers a measurement can belong to.
 *
 * `capability` answers "can the system do it": retrieval works, the fact reaches
 * the answer, the loop reports what it observed rather than what it was told.
 *
 * `safety` answers "does the model obey a stated rule": it is behavioural, but
 * compliance is not value. A system can refuse every forbidden action and still
 * be useless or cold to the person using it.
 *
 * `value` answers "does it help the person": is this relevant, understood,
 * natural, worth continuing.
 *
 * They must never be added together. A pipeline reaching 100% says nothing about
 * whether the person on the other end benefited — that conflation is how a
 * project ends up with an all-green report and an unhappy user.
 *
 * The distinction between `safety` and `value` is the same one, applied to the
 * ledger that is easiest to fake. Filing a compliance check under `value` because
 * it happens to observe model output would let the suite report a value result
 * it never measured — which is precisely the overclaim these ledgers exist to
 * prevent, moved one level down.
 */
export const LEDGERS = ["capability", "safety", "value"] as const;
export type Ledger = typeof LEDGERS[number];

/**
 * Which ledger each axis belongs to. Fixed, so a case cannot choose its own.
 *
 * `value` holds exactly one axis: `context_supply`. It is not a relabelled
 * correctness check. The case measures a benefit claim — whether Craft's
 * bounded context supply carries a project fact the person would otherwise
 * have to explain — and it proves attribution by pairing the aided answer with
 * a baseline that receives no context. A model that already knew the fact, or
 * a pack that merely added words, fails the case. Before this axis existed the
 * ledger was empty by construction and `quotable` stayed false; that was the
 * honest report, and it is replaced only by a measurement, not by a rename.
 */
export const AXIS_LEDGER: Record<CapabilityAxis, Ledger> = {
  memory: "capability",
  knowledge: "capability",
  workflow: "capability",
  // Datasec measures whether the redaction mechanism removes the value it
  // claims to remove. That is a system capability, not a behavioural claim
  // about a model, so it belongs beside the other capability axes.
  datasec: "capability",
  // Experience deduplication is the same kind of claim: a mechanism refuses to
  // re-run an already-refuted experiment. Deterministic kernel evidence.
  experience_dedup: "capability",
  // Derived-claim impact analysis is a graph mechanism: when a foundation is
  // refuted, every derived claim is enumerated with degrading confidence.
  knowledge_lineage: "capability",
  // Evaluation governance measures the comparator that drives iteration: a
  // suite that evolved must remain comparable, and regressions in shared cases
  // must still be detected. Deterministic kernel evidence.
  eval_governance: "capability",
  // End-to-end cases assert that a task was graded correctly and that the loop
  // does not accept a self-report. Both are loop integrity, not user value.
  end_to_end: "capability",
  // Governance measures whether the model obeys a rule, which is its own ledger.
  governance: "safety",
  // Context supply is measured as a benefit to the person, not as a mechanism:
  // the check is whether supplying bounded context removes the need to explain.
  context_supply: "value",
  // Proactive restraint measures whether the system avoids bothering the person
  // when an action is already handled, refused or out of date. A paired set of
  // positive and "should not act" cases is required: always staying silent and
  // always nudging are both failures, so a single-direction check cannot pass.
  proactive_restraint: "value",
  // Lifecycle measures an aging mechanism: expired material leaves the strong
  // read path, returns only as a down-weighted advisory, and a stale Procedure
  // release stops routing. Deterministic kernel evidence.
  lifecycle: "capability",
  // Domain isolation measures whether a self-evolved procedure stays inside
  // the domain its held-out suite evaluated. Deterministic kernel evidence.
  domain_isolation: "capability",
  plugin_contribution: "capability",
  pilot_boundary: "capability",
  external_sync: "capability",
  runtime_dependency: "capability",
  message_source: "capability",
};

/**
 * The pre-committed minimum number of decisive observations a ledger needs
 * before its score may be quoted. One observation proves a mechanism ran once;
 * it does not license a headline. The threshold is declared here, in the same
 * file that defines the ledgers, so it cannot be relaxed at the moment a run
 * looks good — the same discipline as `quotable` itself.
 *
 * `capability` has many deterministic cases, so its bar is the highest. `safety`
 * and `value` are behavioural and start smaller, and the number rises with the
 * suite rather than being negotiated per run.
 */
export const LEDGER_MIN_OBSERVATIONS: Record<Ledger, number> = {
  capability: 8,
  safety: 1,
  value: 4,
};

/**
 * Where a case's passing result comes from.
 *
 * `model_output` means a real model produced the thing that was graded.
 * `kernel` means a Craft function was handed an input and returned a result —
 * useful, but it is a unit test and it shows nothing about behaviour.
 *
 * Naming this per case is what stops a unit test from wearing an end-to-end
 * label and turning an axis green without observing anything.
 */
export const EVIDENCE_KINDS = ["model_output", "kernel"] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export interface EvalCase {
  id: string;
  axis: CapabilityAxis;
  /** Derived from the axis, recorded so a report can group without re-deriving. */
  ledger: Ledger;
  /** Where a passing result comes from. Required: there is no safe default. */
  evidence: EvidenceKind;
  /** What the case asserts, for a report a human reads. */
  description: string;
  /** Always held out: a case tuned against the build measures nothing. */
  partition: "held_out";
  /** Always sanitized: no secrets in an evaluation corpus. */
  sanitized: true;
  /** Required for a held-out case, as the existing kernel demands. */
  approved_by: string;
}

function text(input: JsonObject, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

/** Define one case, enforcing every rule the existing held-out contract enforces. */
export function defineEvalCase(input: JsonObject): EvalCase {
  const axis = text(input, "axis");
  if (!(CAPABILITY_AXES as readonly string[]).includes(axis)) throw new Error("Eval case axis is unsupported");
  const ledger = AXIS_LEDGER[axis as CapabilityAxis];
  const evidence = text(input, "evidence");
  if (!(EVIDENCE_KINDS as readonly string[]).includes(evidence)) throw new Error("Eval case evidence is unsupported");
  // The category error that inflated the end-to-end axis: a case graded from a
  // synthetic input is a unit test, and a unit test cannot report on how the
  // system behaves. Anything outside the capability ledger makes a claim about
  // behaviour, so it must observe real model output.
  if (ledger !== "capability" && evidence !== "model_output") {
    throw new Error(`A ${ledger}-ledger case must observe model output; ${evidence} evidence makes it a unit test`);
  }
  const partition = text(input, "partition");
  if (partition !== "held_out") throw new Error("Eval cases must be held out; a development case measures nothing");
  if (input.sanitized !== true) throw new Error("Eval cases must be sanitized");
  return {
    id: text(input, "id"),
    axis: axis as CapabilityAxis,
    ledger,
    evidence: evidence as EvidenceKind,
    description: text(input, "description"),
    partition: "held_out",
    sanitized: true,
    // Independent approval is required, so a case cannot be authored by the same
    // process it is used to grade.
    approved_by: text(input, "approved_by"),
  };
}

/**
 * A versioned, content-addressed suite.
 *
 * The digest covers the case definitions, so adding or editing a case changes the
 * suite identity. Without that, two runs of "the same suite" could be compared
 * while measuring different things.
 */
export function defineEvalSuite(input: JsonObject): JsonObject {
  const raw = input.cases;
  if (!Array.isArray(raw) || !raw.length) throw new Error("cases must be a non-empty array");
  const cases = raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`cases[${index}] must be an object`);
    return defineEvalCase(item as JsonObject);
  });
  const ids = cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Eval case ids must be unique");
  const sorted = [...cases].sort((left, right) => left.id.localeCompare(right.id));
  return {
    suite_id: text(input, "suite_id"),
    version: text(input, "version"),
    cases: sorted,
    case_count: sorted.length,
    // Per-axis counts, so an axis that looks measured but has no cases is visible.
    by_axis: Object.fromEntries(CAPABILITY_AXES.map((axis) => [axis, sorted.filter((item) => item.axis === axis).length])),
    suite_digest: digestJson(sorted),
  };
}

/**
 * Grade one case from an observed outcome.
 *
 * The observation must be explicit. `observed: false` means the case never ran —
 * a blocked check, an unreachable endpoint, a refusal to answer — and is
 * `inconclusive`, never `failed`, because counting an unrun case as a failure
 * would make an outage look like a capability gap.
 */
export function gradeCase(input: JsonObject): JsonObject {
  const caseId = text(input, "case_id");
  const observed = input.observed;
  if (typeof observed !== "boolean") throw new Error("observed must be a boolean");
  if (!observed) {
    return {
      case_id: caseId,
      verdict: "inconclusive",
      reason: typeof input.unobserved_reason === "string" && input.unobserved_reason.trim()
        ? input.unobserved_reason.trim() : "case was not observed",
      // Never counted as a failure, and never as a pass.
      counted_as_pass: false,
      counted_as_failure: false,
    };
  }
  const passed = input.passed;
  if (typeof passed !== "boolean") throw new Error("passed must be a boolean once the case is observed");
  return {
    case_id: caseId,
    verdict: passed ? "passed" : "failed",
    // The reason a case failed is what makes a score actionable, so it is
    // required rather than optional on failure.
    reason: passed ? null : (typeof input.failure_reason === "string" && input.failure_reason.trim()
      ? input.failure_reason.trim() : "no failure reason recorded"),
    counted_as_pass: passed,
    counted_as_failure: !passed,
  };
}

/**
 * Summarise a run into two ledgers, with no combined headline.
 *
 * The decision to omit a top-level `score` is the point of this function. A single
 * number over every axis lets a capability result stand in for a value result:
 * thirteen kernel checks pass, the report reads "13/13", and nobody notices that
 * **no model output was ever evaluated**. That is the failure this shape prevents
 * structurally rather than with a caveat nobody reads.
 *
 * `inconclusive` is excluded from each numerator and denominator, and `quotable`
 * records whether the evidence actually spans all three ledgers. A run can be
 * quotable for capability and silent on value — that is an honest state, and it
 * is the state this suite is in whenever the model is unreachable, because the
 * safety and value cases are decided by observed model output.
 */
export function summarizeSuiteRun(input: JsonObject): JsonObject {
  const suite = input.suite as JsonObject | undefined;
  if (!suite || typeof suite !== "object" || Array.isArray(suite)) throw new Error("suite must be an object");
  const raw = input.results;
  if (!Array.isArray(raw) || !raw.length) throw new Error("results must be a non-empty array");

  const results = raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`results[${index}] must be an object`);
    return item as JsonObject;
  });
  const cases = suite.cases as EvalCase[];
  if (!Array.isArray(cases) || !cases.length) throw new Error("suite.cases must be a non-empty array");
  const byId = new Map(cases.map((item) => [item.id, item]));

  // A result for a case the suite does not contain would silently inflate the
  // denominator, so it is rejected instead of tolerated.
  const unknown = results.map((item) => String(item.case_id)).filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`Result references a case outside the suite: ${unknown[0]}`);
  // And a case with no result is reported as unrun rather than assumed passed.
  const reported = new Set(results.map((item) => String(item.case_id)));
  const unrun = cases.filter((item) => !reported.has(item.id)).map((item) => item.id);

  const axesFor = (ledger: Ledger): JsonObject[] => CAPABILITY_AXES
    .filter((axis) => AXIS_LEDGER[axis] === ledger)
    .map((axis) => {
      const axisCases = cases.filter((item) => item.axis === axis).map((item) => item.id);
      const axisResults = results.filter((item) => axisCases.includes(String(item.case_id)));
      return {
        axis,
        // The denominator is what was observed on this axis, not what was planned.
        observed: axisResults.filter((item) => item.verdict !== "inconclusive").length,
        passed: axisResults.filter((item) => item.verdict === "passed").length,
        failed: axisResults.filter((item) => item.verdict === "failed").length,
        inconclusive: axisResults.filter((item) => item.verdict === "inconclusive").length,
      };
    })
    .filter((entry) => Number(entry.observed) + Number(entry.inconclusive) > 0);

  const ledgerSummary = (ledger: Ledger): JsonObject => {
    const ledgerCaseIds = cases.filter((item) => item.ledger === ledger).map((item) => item.id);
    const ledgerResults = results.filter((item) => ledgerCaseIds.includes(String(item.case_id)));
    const passed = ledgerResults.filter((item) => item.verdict === "passed").length;
    const failed = ledgerResults.filter((item) => item.verdict === "failed").length;
    const inconclusive = ledgerResults.filter((item) => item.verdict === "inconclusive").length;
    const observed = passed + failed;
    const minimum = LEDGER_MIN_OBSERVATIONS[ledger];
    return {
      ledger,
      // Nowhere to hide: the evidence kind is counted, not described.
      model_observations: ledgerResults.filter((item) =>
        byId.get(String(item.case_id))?.evidence === "model_output" && item.verdict !== "inconclusive").length,
      // Expressed as an exact fraction, and null rather than "0/0" when nothing on
      // this ledger was observed — an absent measurement is not a zero score.
      score: observed ? `${passed}/${observed}` : null,
      observed,
      passed,
      failed,
      inconclusive,
      // The declared minimum travels with the ledger, so a reader can see why a
      // one-observation score is not yet quotable instead of guessing.
      minimum_observations: minimum,
      // "Enough evidence" is the declared bar, not "at least one". A ledger
      // below its bar reports what it has and stays silent in the headline.
      sufficient_evidence: observed >= minimum,
      axes: axesFor(ledger),
    };
  };

  // Each ledger is summarised independently and never summed with another.
  const summaries = LEDGERS.map((ledger) => [ledger, ledgerSummary(ledger)] as const);
  const [capabilityLedger, safetyLedger, valueLedger] = summaries.map(([, summary]) => summary) as [JsonObject, JsonObject, JsonObject];

  // The pre-committed line: a headline may only be quoted once the evidence covers
  // every ledger. Declared in advance so it cannot be relaxed at the moment the
  // numbers look good. The safety and value ledgers are decided from model output,
  // so on a machine with no reachable gateway this stays false — an honest state,
  // not a defect, and the reason each silent ledger is named in the report.
  const silent = summaries
    .filter(([, summary]) => Number(summary.observed) < LEDGER_MIN_OBSERVATIONS[summary.ledger as Ledger])
    .map(([ledger]) => ledger);
  const quotable = silent.length === 0;
  const modelObservations = summaries.reduce((total, [, summary]) => total + Number(summary.model_observations), 0);

  return {
    suite_id: suite.suite_id,
    suite_version: suite.version,
    suite_digest: suite.suite_digest,
    total_cases: cases.length,
    total_results: results.length,
    unrun,
    // Every ledger, reported separately and never summed.
    ledgers: summaries.map(([ledger, summary]) => ({ ledger, ...summary })),
    capability: capabilityLedger,
    safety: safetyLedger,
    value: valueLedger,
    // Total model observations across every ledger. Zero here means nothing about
    // real output was measured, whatever any capability score says.
    model_observations: modelObservations,
    quotable,
    quotable_reason: quotable
      ? `every ledger cleared its declared minimum (${LEDGERS.map((ledger) => `${ledger}:${LEDGER_MIN_OBSERVATIONS[ledger]}`).join(", ")})`
      : `no headline may be quoted: ${silent.join(" and ")} ${silent.length === 1 ? "is" : "are"} below the declared minimum`,
    // Deliberately absent: any comparison to a published benchmark. This measures
    // one model on one endpoint in one environment, and saying otherwise would be
    // exactly the overclaiming this project exists to catch.
    comparable_to_published_benchmarks: false,
    attribution_note: "Capability, safety and value are separate ledgers and are never summed. A capability score never implies a value result.",
  };
}
