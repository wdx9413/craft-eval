/**
 * Static quality and contamination checks for evaluation suites.
 *
 * This module never treats a declaration such as `sanitized: true` as proof of
 * independence. Findings are deterministic and machine-readable.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { digest, loadSuite, type Case, type Suite } from './evaluation.js';

export type AuditSeverity = 'error' | 'warning' | 'info';
export type AuditStatus = 'passed' | 'warnings' | 'failed';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
  suite_ids: string[];
  case_ids: string[];
}

export interface CaseAudit {
  suite_id: string;
  case_id: string;
  content_digest: string;
  normalized_prompt_digest: string | null;
  acceptance_digest: string;
  information_checks: number;
}

export interface SuiteAudit {
  schema: 'craft-eval.audit.v1';
  status: AuditStatus;
  suites: Array<{
    suite_id: string;
    partition: Suite['partition'];
    cases: number;
    content_digest: string;
    approved_by: string | null;
    claim: string | null;
    expires_at: string | null;
  }>;
  cases: CaseAudit[];
  findings: AuditFinding[];
}

export interface AuditSummary {
  status: AuditStatus;
  suites: number;
  cases: number;
  errors: number;
  warnings: number;
  infos: number;
}

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function informationChecks(item: Case): number {
  return (item.checks ?? []).filter((check) => {
    if (check.kind === 'trace_event') {
      return true;
    }
    if (check.kind === 'tool_call') {
      return check.called === true;
    }
    return true;
  }).length;
}

function finding(
  code: string,
  severity: AuditSeverity,
  message: string,
  suites: string[],
  cases: string[] = [],
): AuditFinding {
  return {
    code,
    severity,
    message,
    suite_ids: [...new Set(suites)].sort(),
    case_ids: [...new Set(cases)].sort(),
  };
}

function groupBy<T>(values: T[], key: (value: T) => string | null): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const itemKey = key(value);
    if (itemKey === null) {
      continue;
    }
    const current = result.get(itemKey) ?? [];
    current.push(value);
    result.set(itemKey, current);
  }
  return result;
}

export function auditSuites(suites: Suite[]): SuiteAudit {
  if (suites.length === 0) {
    throw new Error('audit requires at least one suite');
  }
  const findings: AuditFinding[] = [];
  const cases: CaseAudit[] = [];
  const suiteIds = new Set<string>();

  for (const suite of suites) {
    if (suiteIds.has(suite.suite_id)) {
      findings.push(
        finding('duplicate_suite_id', 'error', `suite ID is repeated: ${suite.suite_id}`, [suite.suite_id]),
      );
    }
    suiteIds.add(suite.suite_id);
    if (suite.partition === 'held_out') {
      if (suite.approved_by === undefined) {
        findings.push(
          finding('held_out_not_reviewed', 'error', 'held-out suite has no independent reviewer', [suite.suite_id]),
        );
      }
      const reviewed = suite.cases.filter((item) => item.provenance?.reviewed_by !== undefined).length;
      if (reviewed !== suite.cases.length) {
        findings.push(
          finding(
            'held_out_case_review_incomplete',
            'warning',
            `${suite.cases.length - reviewed} held-out cases lack a case-level reviewer`,
            [suite.suite_id],
            suite.cases.filter((item) => item.provenance?.reviewed_by === undefined).map((item) => item.id),
          ),
        );
      }
      const independent = suite.cases.filter((item) => item.provenance?.independent_of_training === true).length;
      if (independent !== suite.cases.length) {
        findings.push(
          finding(
            'held_out_independence_undeclared',
            'warning',
            `${suite.cases.length - independent} held-out cases do not declare independence from training`,
            [suite.suite_id],
            suite.cases
              .filter((item) => item.provenance?.independent_of_training !== true)
              .map((item) => item.id),
          ),
        );
      }
    }
    if (suite.claim === undefined) {
      findings.push(
        finding('suite_claim_missing', 'warning', 'suite does not state the claim it can support', [suite.suite_id]),
      );
    }
    if (suite.metrics === undefined) {
      findings.push(
        finding(
          'suite_metrics_missing',
          'warning',
          'suite does not declare a primary metric or guardrails',
          [suite.suite_id],
        ),
      );
    }
    if (suite.expires_at !== undefined) {
      const today = new Date().toISOString().slice(0, 10);
      if (suite.expires_at < today) {
        findings.push(
          finding('suite_expired', 'error', `suite expired on ${suite.expires_at}`, [suite.suite_id]),
        );
      }
    }

    // The contract keeps subject_kind open, but the executor only implements
    // software/agent/skill. Surface anything else so authors do not assume a
    // dedicated execution path exists for it.
    if (suite.subject_kind !== 'software' && suite.subject_kind !== 'agent' && suite.subject_kind !== 'skill') {
      findings.push(
        finding(
          'subject_kind_unrecognized',
          'warning',
          `subject_kind '${suite.subject_kind}' has no dedicated execution path; only software/agent/skill are implemented`,
          [suite.suite_id],
        ),
      );
    }
    // Business-model derived coverage: an invariant with no negative case is a
    // blind spot by construction, and an unexercised transition is a lifecycle
    // gap. These checks derive from the declared model, not author tags.
    const business = suite.business;
    const caseIds = new Set(suite.cases.map((item) => item.id));
    if (business?.invariants !== undefined) {
      for (const invariant of business.invariants) {
        const unknownRefs = [...invariant.positive_cases, ...invariant.negative_cases].filter(
          (id) => !caseIds.has(id),
        );
        if (unknownRefs.length > 0) {
          findings.push(
            finding(
              'business_invariant_unknown_case',
              'error',
              `invariant ${invariant.id} references unknown case(s): ${unknownRefs.join(', ')}`,
              [suite.suite_id],
            ),
          );
        }
        if (invariant.negative_cases.length === 0) {
          findings.push(
            finding(
              'business_invariant_no_negative',
              'warning',
              `invariant ${invariant.id} has no negative case: ${invariant.statement}`,
              [suite.suite_id],
            ),
          );
        }
        if (invariant.positive_cases.length === 0) {
          findings.push(
            finding(
              'business_invariant_no_positive',
              'warning',
              `invariant ${invariant.id} has no positive case: ${invariant.statement}`,
              [suite.suite_id],
            ),
          );
        }
      }
    }
    if (business?.transitions !== undefined) {
      const untouched = business.transitions.filter((item) => item.cases.length === 0);
      if (untouched.length > 0) {
        findings.push(
          finding(
            'business_transition_unexercised',
            'warning',
            `lifecycle transition(s) with no cases: ${untouched.map((item) => item.id).join(', ')}`,
            [suite.suite_id],
          ),
        );
      }
      for (const transition of business.transitions) {
        const unknownRefs = transition.cases.filter((id) => !caseIds.has(id));
        if (unknownRefs.length > 0) {
          findings.push(
            finding(
              'business_transition_unknown_case',
              'error',
              `transition ${transition.id} references unknown case(s): ${unknownRefs.join(', ')}`,
              [suite.suite_id],
            ),
          );
        }
      }
    }
    if (business?.rules !== undefined) {
      for (const rule of business.rules) {
        for (const boundary of rule.boundaries) {
          if (boundary.cases.length === 0) {
            findings.push(
              finding(
                'business_rule_boundary_uncovered',
                'warning',
                `rule ${rule.id} boundary ${boundary.value} (${rule.parameter}) has no case`,
                [suite.suite_id],
              ),
            );
          }
          const unknown = boundary.cases.filter((id) => !caseIds.has(id));
          if (unknown.length > 0) {
            findings.push(
              finding(
                'business_rule_unknown_case',
                'error',
                `rule ${rule.id} boundary ${boundary.value} references unknown case(s): ${unknown.join(', ')}`,
                [suite.suite_id],
              ),
            );
          }
        }
      }
    }
    if (business?.incidents !== undefined) {
      for (const incident of business.incidents) {
        const missing = incident.case_ids.filter((id) => !caseIds.has(id));
        if (incident.case_ids.length === 0) {
          findings.push(
            finding(
              'business_incident_unregressed',
              'error',
              `incident ${incident.source} has no regression case`,
              [suite.suite_id],
            ),
          );
        } else if (missing.length > 0) {
          findings.push(
            finding(
              'business_incident_unknown_case',
              'error',
              `incident ${incident.id} references unknown case(s): ${missing.join(', ')}`,
              [suite.suite_id],
            ),
          );
        }
      }
    }

    for (const item of suite.cases) {
      // Gain claims (see compareRuns.skill_gain_supported) require at least 20
      // positive and one negative skill case. Flag the suite early so authors
      // size their held-out set before running a meaningless comparison.
      if (suite.subject_kind === 'skill') {
        const positive = suite.cases.filter((caseItem) => caseItem.skill?.should_trigger === true).length;
        const negative = suite.cases.filter((caseItem) => caseItem.skill?.should_trigger === false).length;
        if (positive < 20) {
          findings.push(
            finding(
              'skill_gain_sample_insufficient',
              'warning',
              `skill gain claims need >=20 positive cases; only ${positive} declared`,
              [suite.suite_id],
            ),
          );
        }
        if (negative < 1) {
          findings.push(
            finding(
              'skill_gain_no_negative',
              'warning',
              'skill gain claims need at least one negative case',
              [suite.suite_id],
            ),
          );
        }
      }
      // boundaries are declarative unless the subject provides an enforcing
      // sandbox. A network deny with no declared enforcement is not enforced,
      // so surface it instead of letting it read as a guardrail.
      if (suite.boundaries?.network === 'deny') {
        findings.push(
          finding(
            'boundaries_declared_unenforced',
            'warning',
            'boundaries.network=deny is declarative; network isolation requires an external sandbox',
            [suite.suite_id],
          ),
        );
      }
      const normalizedPrompt = item.prompt === undefined ? null : normalizedText(item.prompt);
      const acceptanceDigest = digest({
        checks: item.checks ?? [],
        safety_checks: item.safety_checks ?? [],
        skill: item.skill ?? null,
        mcp: item.mcp ?? null,
      });
      cases.push({
        suite_id: suite.suite_id,
        case_id: item.id,
        content_digest: digest({
          prompt: normalizedPrompt,
          argv: item.argv ?? null,
          driver: item.driver ?? null,
          checks: item.checks ?? [],
          safety_checks: item.safety_checks ?? [],
          skill: item.skill ?? null,
          mcp: item.mcp ?? null,
          workspace: item.workspace ?? null,
          in_place: item.in_place ?? false,
        }),
        normalized_prompt_digest: normalizedPrompt === null ? null : sha256(normalizedPrompt),
        acceptance_digest: acceptanceDigest,
        information_checks: informationChecks(item),
      });
      if (item.provenance === undefined) {
        findings.push(
          finding(
            'case_provenance_missing',
            'warning',
            'case does not declare where it came from',
            [suite.suite_id],
            [item.id],
          ),
        );
      }
      if (item.expected_behavior === undefined) {
        findings.push(
          finding(
            'case_expected_behavior_missing',
            'warning',
            'case does not state the expected behavior',
            [suite.suite_id],
            [item.id],
          ),
        );
      }
      if (informationChecks(item) === 0) {
        findings.push(
          finding(
            'case_without_information',
            'error',
            'case has no task check that distinguishes a correct result from an arbitrary result',
            [suite.suite_id],
            [item.id],
          ),
        );
      }
      if ((item.checks ?? []).length === 0 && item.skill?.should_trigger === false) {
        findings.push(
          finding(
            'negative_case_only_trigger',
            'info',
            'negative skill case is judged only by trigger evidence',
            [suite.suite_id],
            [item.id],
          ),
        );
      }
    }
  }

  for (const [contentDigest, duplicates] of groupBy(cases, (item) => item.content_digest)) {
    if (duplicates.length > 1) {
      findings.push(
        finding(
          'duplicate_case_content',
          'error',
          `cases share identical normalized content (${contentDigest.slice(0, 12)})`,
          duplicates.map((item) => item.suite_id),
          duplicates.map((item) => item.case_id),
        ),
      );
    }
  }
  for (const duplicates of groupBy(cases, (item) => item.normalized_prompt_digest).values()) {
    if (duplicates.length > 1) {
      findings.push(
        finding(
          'duplicate_prompt',
          'error',
          'multiple cases share the same normalized prompt',
          duplicates.map((item) => item.suite_id),
          duplicates.map((item) => item.case_id),
        ),
      );
    }
  }
  for (const duplicates of groupBy(cases, (item) => item.acceptance_digest).values()) {
    const suiteSet = new Set(duplicates.map((item) => item.suite_id));
    if (duplicates.length > 1 && suiteSet.size === 1) {
      findings.push(
        finding(
          'duplicate_acceptance',
          'warning',
          'multiple cases have identical checks; confirm they test distinct behavior',
          duplicates.map((item) => item.suite_id),
          duplicates.map((item) => item.case_id),
        ),
      );
    }
  }

  const byPartition = new Map<string, CaseAudit[]>();
  for (const suite of suites) {
    const items = cases.filter((item) => item.suite_id === suite.suite_id);
    byPartition.set(suite.partition, [...(byPartition.get(suite.partition) ?? []), ...items]);
  }
  const development = byPartition.get('development') ?? [];
  const heldOut = byPartition.get('held_out') ?? [];
  const heldOutPrompts = new Set(
    heldOut.map((item) => item.normalized_prompt_digest).filter((item): item is string => item !== null),
  );
  const reused = development.filter(
    (item) => item.normalized_prompt_digest !== null && heldOutPrompts.has(item.normalized_prompt_digest),
  );
  if (reused.length > 0) {
    findings.push(
      finding(
        'development_held_out_reuse',
        'error',
        'development prompts also appear in the held-out set',
        reused.map((item) => item.suite_id),
        reused.map((item) => item.case_id),
      ),
    );
  }

  const severity = findings.some((item) => item.severity === 'error')
    ? 'failed'
    : findings.some((item) => item.severity === 'warning')
      ? 'warnings'
      : 'passed';
  return {
    schema: 'craft-eval.audit.v1',
    status: severity,
    suites: suites.map((suite) => ({
      suite_id: suite.suite_id,
      partition: suite.partition,
      cases: suite.cases.length,
      content_digest: digest(suite),
      approved_by: suite.approved_by ?? null,
      claim: suite.claim?.statement ?? null,
      expires_at: suite.expires_at ?? null,
    })),
    cases,
    findings: findings.sort((a, b) => a.code.localeCompare(b.code) || a.case_ids.join(',').localeCompare(b.case_ids.join(','))),
  };
}

/**
 * Audit loaded suites plus raw duplicate-ID detection.
 *
 * `loadSuite` rejects duplicate IDs as a contract error. The audit reads the raw
 * JSON first so that duplicate IDs become a structured finding instead of only
 * an exception; all other invalid shapes still fail closed.
 */
export async function auditSuiteFiles(paths: string[]): Promise<SuiteAudit> {
  if (paths.length === 0) {
    throw new Error('audit requires at least one suite path');
  }
  const duplicateFindings: AuditFinding[] = [];
  for (const path of paths) {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const document = raw as Record<string, unknown>;
    const suiteId = typeof document.suite_id === 'string' ? document.suite_id : path;
    if (!Array.isArray(document.cases)) {
      continue;
    }
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const item of document.cases) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const id = (item as Record<string, unknown>).id;
      if (typeof id !== 'string') {
        continue;
      }
      if (seen.has(id)) {
        repeated.add(id);
      }
      seen.add(id);
    }
    if (repeated.size > 0) {
      duplicateFindings.push(
        finding(
          'duplicate_case_id',
          'error',
          'case IDs must be unique',
          [suiteId],
          [...repeated],
        ),
      );
    }
  }
  if (duplicateFindings.length > 0) {
    return {
      schema: 'craft-eval.audit.v1',
      status: 'failed',
      suites: [],
      cases: [],
      findings: duplicateFindings,
    };
  }
  const suites = await Promise.all(paths.map((path) => loadSuite(path)));
  return auditSuites(suites);
}

export interface SuiteCoverage {
  schema: 'craft-eval.coverage.v1';
  suites: Array<{
    suite_id: string;
    cases: number;
    by_category: Record<string, number>;
    by_risk: Record<string, number>;
    by_difficulty: Record<string, number>;
    by_language: Record<string, number>;
    by_check_kind: Record<string, number>;
    positives: number;
    negatives: number;
    undeclared: number;
  }>;
  gaps: string[];
}

function tally(values: Array<string | undefined>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? 'undeclared';
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

/**
 * Coverage matrix for one or more suites. It answers "did we test enough of
 * every dimension we declared?" without pretending a matrix can prove
 * correctness; undeclared buckets are surfaced, not hidden.
 */
export function coverageSuites(suites: Suite[]): SuiteCoverage {
  if (suites.length === 0) {
    throw new Error('coverage requires at least one suite');
  }
  const kinds = ['exit_code', 'file_exists', 'json_equals', 'trace_event', 'script', 'tool_call', 'stdout_contains', 'stdout_not_contains', 'model_graded'];
  const suitesOut = suites.map((suite) => {
    const caseKinds = suite.cases.flatMap((item) => [
      ...(item.checks ?? []),
      ...(item.safety_checks ?? []),
    ].map((check) => check.kind));
    return {
      suite_id: suite.suite_id,
      cases: suite.cases.length,
      by_category: tally(suite.cases.map((item) => item.category)),
      by_risk: tally(suite.cases.map((item) => item.risk)),
      by_difficulty: tally(suite.cases.map((item) => item.difficulty)),
      by_language: tally(suite.cases.map((item) => item.language)),
      by_check_kind: Object.fromEntries(kinds.map((kind) => [kind, caseKinds.filter((item) => item === kind).length])),
      positives: suite.cases.filter((item) => item.skill?.should_trigger === true).length,
      negatives: suite.cases.filter((item) => item.skill?.should_trigger === false).length,
      undeclared: suite.cases.filter(
        (item) => item.category === undefined && item.risk === undefined && item.difficulty === undefined,
      ).length,
    };
  });
  const gaps: string[] = [];
  for (const suite of suitesOut) {
    if (suite.by_category.undeclared === suite.cases) {
      gaps.push(`${suite.suite_id}: every case lacks a category tag`);
    }
    if (suite.by_risk.undeclared === suite.cases) {
      gaps.push(`${suite.suite_id}: every case lacks a risk tag`);
    }
    if (suite.undeclared > 0) {
      gaps.push(`${suite.suite_id}: ${suite.undeclared} case(s) have no category/risk/difficulty`);
    }
  }
  return { schema: 'craft-eval.coverage.v1', suites: suitesOut, gaps };
}

export async function coverageSuiteFiles(paths: string[]): Promise<SuiteCoverage> {
  if (paths.length === 0) {
    throw new Error('coverage requires at least one suite path');
  }
  return coverageSuites(await Promise.all(paths.map((path) => loadSuite(path))));
}
