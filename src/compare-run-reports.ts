/**
 * Baseline-vs-candidate comparison for `craft-eval-run-report.v1` artifacts.
 *
 * This is a different seam from `craft-eval`'s `compareRuns`: that one compares
 * controlled evaluator result directories; this one compares two released
 * three-ledger suite summaries. It refuses to compare runs whose identity
 * (provider, endpoint, model or suite digest) differs, because a different
 * gateway or a different suite is not a candidate of the same baseline.
 *
 * The `suite_digest` is deliberately reported as *evolution*, not treated as a
 * blocking identity field. The suite is the artefact being iterated: adding a
 * held-out axis or case changes its digest by design. Blocking comparison on it
 * would silence the regression detector exactly when the suite evolves, which
 * is the opposite of what a comparison used to drive iteration is for. Regression
 * detection still runs over the case ids common to both runs; removals are
 * surfaced so a shrinking denominator cannot hide a regression.
 */
import { LEDGERS } from "./eval-suite.ts";
import type { JsonObject } from 'craft-common-store-local/';

export interface RunReport {
  schema: string;
  recorded_at?: string;
  provider?: string;
  base_url?: string;
  model?: string;
  api_key_env?: string;
  isolation?: string;
  suite_id?: string;
  suite_version?: string;
  suite_digest?: string;
  quotable?: boolean;
  quotable_reason?: string;
  ledgers?: JsonObject[];
  model_observations?: number;
  prompted_turns?: number;
  minimum_observations?: JsonObject;
  results?: Array<{ case_id?: string; verdict?: string; reason?: string }>;
}

export interface LedgerDelta {
  ledger: string;
  baseline: string | null;
  candidate: string | null;
  baselineObserved: number;
  candidateObserved: number;
  baselinePassed: number;
  candidatePassed: number;
  passedDelta: number;
}

export interface Comparison {
  comparable: boolean;
  reason: string;
  identity: { provider: string; base_url: string; model: string; suite_digest: string; isolation: string };
  /** True when the two runs measured different (versioned) suite definitions. */
  suite_evolution: boolean;
  /** Baseline digest -> candidate digest, present only on evolution. */
  suite_digest_delta: { baseline: string; candidate: string } | null;
  ledgers: LedgerDelta[];
  regressions: string[];
  improvements: string[];
  newCases: string[];
  removedCases: string[];
}

/** Fields that must match for two runs to be comparable at all. */
const IDENTITY_FIELDS = ["provider", "base_url", "model"] as const;
/** Fields that must be present but may legitimately evolve between runs. */
const REQUIRED_FIELDS = [...IDENTITY_FIELDS, "suite_digest"] as const;

function asReport(value: unknown, label: string): RunReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a report object`);
  const report = value as RunReport;
  if (report.schema !== "craft-eval-run-report.v1") throw new Error(`${label} has an unsupported report schema`);
  for (const field of REQUIRED_FIELDS) {
    if (typeof report[field] !== "string" || !String(report[field])) throw new Error(`${label} is missing run identity field ${field}`);
  }
  return report;
}

function ledgerScore(report: RunReport, ledger: string): { score: string | null; observed: number; passed: number } {
  const row = (report.ledgers ?? []).find((item) => String(item.ledger) === ledger);
  return {
    score: row && row.score !== null && row.score !== undefined ? String(row.score) : null,
    observed: Number(row?.observed ?? 0),
    passed: Number(row?.passed ?? 0),
  };
}

function verdictMap(report: RunReport): Map<string, string> {
  const map = new Map<string, string>();
  for (const result of report.results ?? []) {
    if (typeof result.case_id === "string") map.set(result.case_id, String(result.verdict ?? "unknown"));
  }
  return map;
}

/** Pure comparison function: the interface is the check surface, so callers
 *  only need to supply two parsed artifacts and one reason string is returned. */
export function compareRunReports(baselineValue: unknown, candidateValue: unknown): Comparison {
  const baseline = asReport(baselineValue, "baseline");
  const candidate = asReport(candidateValue, "candidate");
  const mismatches = IDENTITY_FIELDS.filter((field) => baseline[field] !== candidate[field]);
  const identity = {
    provider: String(baseline.provider), base_url: String(baseline.base_url),
    model: String(baseline.model), suite_digest: String(baseline.suite_digest),
    isolation: String(baseline.isolation ?? "unspecified"),
  };
  const suiteEvolution = baseline.suite_digest !== candidate.suite_digest;
  const suiteDigestDelta = suiteEvolution
    ? { baseline: String(baseline.suite_digest), candidate: String(candidate.suite_digest) } : null;
  // Isolation level is part of comparability for reports that declare it. A
  // run that upgraded to per-trial clean environments is not a candidate of a
  // shared-store baseline, and vice versa.
  const isolationMismatch = baseline.isolation !== candidate.isolation;
  if (mismatches.length || isolationMismatch) {
    const reasons = [...mismatches, ...(isolationMismatch ? ["isolation"] : [])];
    return { comparable: false, reason: `run identity differs: ${reasons.join(", ")}`, identity,
      suite_evolution: suiteEvolution, suite_digest_delta: suiteDigestDelta,
      ledgers: [], regressions: [], improvements: [], newCases: [], removedCases: [] };
  }

  const ledgers: LedgerDelta[] = (LEDGERS as readonly string[]).map((ledger) => {
    const before = ledgerScore(baseline, ledger);
    const after = ledgerScore(candidate, ledger);
    return { ledger, baseline: before.score, candidate: after.score,
      baselineObserved: before.observed, candidateObserved: after.observed,
      baselinePassed: before.passed, candidatePassed: after.passed,
      passedDelta: after.passed - before.passed };
  });

  const before = verdictMap(baseline);
  const after = verdictMap(candidate);
  const regressions: string[] = [];
  const improvements: string[] = [];
  const newCases: string[] = [];
  const removedCases: string[] = [];
  for (const [id, verdict] of before) {
    const next = after.get(id);
    if (next === undefined) { removedCases.push(id); continue; }
    if (verdict === "passed" && next !== "passed") regressions.push(`${id}: ${verdict} -> ${next}`);
    if (verdict !== "passed" && next === "passed") improvements.push(`${id}: ${verdict} -> ${next}`);
  }
  for (const id of after.keys()) if (!before.has(id)) newCases.push(id);

  const comparable = true;
  const evolutionNote = suiteEvolution ? "; suite evolved" : "; same suite";
  const reason = `same run identity; ${regressions.length} regression(s), ${improvements.length} improvement(s)${evolutionNote}`;
  return { comparable, reason, identity, suite_evolution: suiteEvolution, suite_digest_delta: suiteDigestDelta,
    ledgers, regressions, improvements, newCases, removedCases };
}
