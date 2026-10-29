/**
 * Structured failure attribution from evaluator-owned observations.
 *
 * Never use model chain-of-thought as evidence. A diagnosis points to a check,
 * trigger result, host observation or infrastructure issue that was recorded.
 */

import type { CaseResult, CheckResult, RunReport } from './evaluation.js';

export type FailureCategory =
  | 'infrastructure_error'
  | 'fixture_error'
  | 'host_error'
  | 'model_error'
  | 'skill_not_triggered'
  | 'skill_mis_triggered'
  | 'wrong_tool'
  | 'wrong_arguments'
  | 'permission_error'
  | 'timeout'
  | 'recovery_failed'
  | 'task_output_invalid'
  | 'safety_violation'
  | 'external_dependency_missing'
  | 'unknown';

export interface FailureAttribution {
  case_id: string;
  trial: number;
  verdict: CaseResult['verdict'];
  category: FailureCategory;
  stage: 'setup' | 'execution' | 'trigger' | 'task_check' | 'safety_check' | 'unknown';
  first_failed_check: string | null;
  evidence: Record<string, unknown>;
}

export interface AttributionReport {
  schema: 'craft-eval.attribution.v1';
  run_id: string;
  total: number;
  failed: number;
  clusters: Array<{ category: FailureCategory; count: number; cases: string[] }>;
  hotspots: {
    slowest: Array<{ case_id: string; trial: number; duration_ms: number | null }>;
    most_expensive: Array<{ case_id: string; trial: number; cost_units: number | null }>;
  };
  failures: FailureAttribution[];
}

function failedCheck(results: CheckResult[]): CheckResult | null {
  return results.find((item) => item.passed === false) ?? null;
}

function reasonCategory(check: CheckResult): FailureCategory {
  switch (check.reason) {
    case 'tool_not_called':
      return 'wrong_tool';
    case 'tool_unexpectedly_called':
      return 'wrong_tool';
    case 'arguments_mismatch':
      return 'wrong_arguments';
    case 'outside_workspace':
    case 'symlink_rejected':
      return 'permission_error';
    case 'invalid_json':
    case 'type_mismatch':
    case 'value_mismatch':
    case 'key_missing':
    case 'stdout_missing':
    case 'stdout_present':
    case 'exit_code_mismatch':
      return 'task_output_invalid';
    case 'script_error':
      return 'fixture_error';
    case 'tool_errored':
    case 'no_trace':
    case 'trace_incomplete':
      return 'host_error';
    case 'timer_expired':
      return 'timeout';
    case 'not_found':
    case 'not_a_file':
    case 'oversized':
      return 'task_output_invalid';
    default:
      return 'unknown';
  }
}

function attribute(item: CaseResult): FailureAttribution | null {
  if (item.verdict === 'passed') {
    return null;
  }
  const evidence: Record<string, unknown> = {};
  if (item.issue !== null) {
    evidence.issue = item.issue;
  }
  if (item.host !== null) {
    evidence.host = item.host;
  }
  if (item.trigger !== null) {
    evidence.trigger = item.trigger;
  }
  // A case that was skipped because a precondition was unmet is an environment
  // gap, not a product defect or a fixture/model error.
  if (item.verdict === 'not_applicable' || item.issue?.startsWith('requirement_unmet:')) {
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: 'external_dependency_missing',
      stage: 'setup',
      first_failed_check: null,
      evidence,
    };
  }
  const safetyCheck = failedCheck(item.safety_checks);
  if (safetyCheck !== null) {
    evidence.check_reason = safetyCheck.reason;
    evidence.check_evidence = safetyCheck.evidence;
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: 'safety_violation',
      stage: 'safety_check',
      first_failed_check: safetyCheck.id,
      evidence,
    };
  }
  const taskCheck = failedCheck(item.checks);
  if (taskCheck !== null) {
    evidence.check_reason = taskCheck.reason;
    evidence.check_evidence = taskCheck.evidence;
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: reasonCategory(taskCheck),
      stage: 'task_check',
      first_failed_check: taskCheck.id,
      evidence,
    };
  }
  if (item.trigger?.verdict === 'failed') {
    const expected = item.trigger.expected;
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: expected ? 'skill_not_triggered' : 'skill_mis_triggered',
      stage: 'trigger',
      first_failed_check: null,
      evidence,
    };
  }
  if (item.issue === 'timeout') {
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: 'timeout',
      stage: 'execution',
      first_failed_check: null,
      evidence,
    };
  }
  if (item.issue?.startsWith('adapter_error:')) {
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: 'host_error',
      stage: 'setup',
      first_failed_check: null,
      evidence,
    };
  }
  if (item.verdict === 'invalid') {
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: 'infrastructure_error',
      stage: 'unknown',
      first_failed_check: null,
      evidence,
    };
  }
  if (item.trigger?.verdict === 'inconclusive' || item.trace_complete === false) {
    return {
      case_id: item.case_id,
      trial: item.trial,
      verdict: item.verdict,
      category: 'host_error',
      stage: 'trigger',
      first_failed_check: null,
      evidence,
    };
  }
  return {
    case_id: item.case_id,
    trial: item.trial,
    verdict: item.verdict,
    category: 'unknown',
    stage: 'unknown',
    first_failed_check: null,
    evidence,
  };
}

export function attributeRun(report: RunReport): AttributionReport {
  const failures = report.results
    .map((item) => attribute(item))
    .filter((item): item is FailureAttribution => item !== null);
  const clusters = new Map<FailureCategory, string[]>();
  for (const item of failures) {
    const key = `${item.case_id}#${item.trial}`;
    const current = clusters.get(item.category) ?? [];
    current.push(key);
    clusters.set(item.category, current);
  }
  const byDuration = report.results
    .filter((item) => item.duration_ms !== null)
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
    .slice(0, 10)
    .map((item) => ({ case_id: item.case_id, trial: item.trial, duration_ms: item.duration_ms }));
  const byCost = report.results
    .filter((item) => item.cost_units !== null)
    .sort((a, b) => (b.cost_units ?? 0) - (a.cost_units ?? 0))
    .slice(0, 10)
    .map((item) => ({ case_id: item.case_id, trial: item.trial, cost_units: item.cost_units }));
  return {
    schema: 'craft-eval.attribution.v1',
    run_id: report.run_id,
    total: report.expected,
    failed: failures.length,
    clusters: [...clusters.entries()]
      .map(([category, cases]) => ({ category, count: cases.length, cases: cases.sort() }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    hotspots: { slowest: byDuration, most_expensive: byCost },
    failures,
  };
}
