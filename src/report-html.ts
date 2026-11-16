/** Zero-dependency static HTML report for a run directory. */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { reportRun, type CheckResult, type Comparison, type RunReport } from './evaluation.js';
import { coverageSuites } from './audit.js';
import type { MutationReport } from './mutation.js';

const NOT_MEASURED = '<p><em>not measured</em></p>';

/** Optional artefacts the report can fold in without inventing numbers. */
export interface HtmlReportExtras {
  /** Result of `compare`, when the decision needs a baseline/candidate view. */
  comparison?: Comparison;
  /** Result of `mutation`, when the decision needs a suite-sufficiency view. */
  mutation?: MutationReport;
}

function table(headers: string[], rows: string[][]): string {
  return `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
  <tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr>
  ${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(verdict: string): string {
  const color =
    verdict === 'passed' ? '#16a34a' :
    verdict === 'failed' ? '#dc2626' :
    verdict === 'not_applicable' ? '#6b7280' : '#d97706';
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${esc(verdict)}</span>`;
}

function checkRow(check: CheckResult): string {
  const mark = check.passed === true ? '✔' : check.passed === false ? '✘' : '—';
  const color = check.passed === true ? '#16a34a' : check.passed === false ? '#dc2626' : '#6b7280';
  return `<tr><td style="color:${color}">${mark}</td><td>${esc(check.id)}</td><td>${esc(check.reason)}</td><td><code>${esc(JSON.stringify(check.evidence))}</code></td></tr>`;
}

function caseSection(result: RunReport['results'][number]): string {
  const rows = [...result.checks, ...result.safety_checks].map(checkRow).join('');
  return `<details><summary>${badge(result.verdict)} ${esc(result.case_id)} <small>trial ${esc(result.trial)} · ${esc(result.duration_ms ?? '?')}ms</small></summary>
  <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
  <tr><th></th><th>check</th><th>reason</th><th>evidence</th></tr>${rows}</table></details>`;
}

function comparisonSection(comparison: Comparison | undefined): string {
  if (comparison === undefined) return `<h2>Comparison</h2>${NOT_MEASURED}`;
  const summary = `baseline ${esc(comparison.baseline_run_id.slice(0, 12))} vs candidate ${esc(comparison.candidate_run_id.slice(0, 12))} ·
  status ${esc(comparison.status)} · measured ${esc(comparison.measured_pairs)} / unmeasured ${esc(comparison.unmeasured_pairs)} ·
  candidate wins ${esc(comparison.candidate_wins)} / baseline wins ${esc(comparison.baseline_wins)} / ties ${esc(comparison.ties)} ·
  one-sided p ${esc(comparison.one_sided_p ?? 'not measured')} ·
  diagnostic gain ${esc(comparison.diagnostic_skill_gain)} · supported gain ${esc(comparison.skill_gain_supported)}`;
  const flaky = comparison.flaky_excluded;
  const judges = comparison.judge_agreements;
  const rows: string[] = [];
  if (flaky.length > 0) {
    rows.push(`<h3>Flaky excluded from pairing</h3>${table(['case'], flaky.map((id) => [id]))}`);
  }
  if (judges.length > 0) {
    rows.push(`<h3>Judge agreement</h3>${table(['judge', 'agreement', 'cases'],
      judges.map((item) => [item.judge, item.agreement === null ? 'not measured' : String(item.agreement), String(item.cases)]))}`);
  }
  return `<h2>Comparison</h2><p>${summary}</p>${rows.join('')}`;
}

function mutationSection(mutation: MutationReport | undefined): string {
  if (mutation === undefined) return `<h2>Mutation score</h2>${NOT_MEASURED}`;
  const score = mutation.mutation_score === null ? 'not measured' : String(mutation.mutation_score);
  return `<h2>Mutation score</h2><p>score ${esc(score)} · killed ${esc(mutation.killed)} · survived ${esc(mutation.survived)} · errored ${esc(mutation.errored)}</p>
  ${table(['mutant', 'status', 'expected', 'observed', 'error'], mutation.mutants.map((item) => [
    item.id, item.status, item.expected, item.observed ?? 'not measured', item.error ?? '',
  ]))}`;
}

export async function writeHtmlReport(runDir: string, outputPath: string, extras: HtmlReportExtras = {}): Promise<string> {
  const report = await reportRun(runDir);
  const flaky = report.flaky_cases ?? [];
  const judges = report.by_judge ?? {};
  const disagreements = report.judge_disagreements ?? [];

  const summary = `
  <h1>craft-eval run ${esc(report.run_id.slice(0, 12))}</h1>
  <p><b>${esc(report.suite_id)}</b> · ${esc(report.partition)} ·
  passed ${report.passed} / failed ${report.failed} / inconclusive ${report.inconclusive} /
  invalid ${report.invalid} / missing ${report.missing} / n.a. ${report.not_applicable ?? 0} /
  flaky ${flaky.length}${
    extras.mutation === undefined ? '' : ` · mutation score ${
      extras.mutation.mutation_score === null ? 'not measured' : esc(extras.mutation.mutation_score)}`}</p>`;

  const languageSection = report.by_language === undefined
    ? `<h2>By language</h2>${NOT_MEASURED}`
    : `<h2>By language</h2>${table(['language', 'expected', 'passed', 'failed', 'not applicable'],
        Object.entries(report.by_language).map(([language, counts]) =>
          [language, String(counts.expected), String(counts.passed), String(counts.failed), String(counts.not_applicable)]))}`;

  const judgeSection = Object.keys(judges).length === 0
    ? `<h2>By judge</h2>${NOT_MEASURED}`
    : `<h2>By judge</h2>${table(['judge', 'observed', 'passed', 'failed', 'inconclusive', 'failing cases'],
        Object.entries(judges).map(([judge, counts]) =>
          [judge, String(counts.observed), String(counts.passed), String(counts.failed),
            String(counts.inconclusive), counts.cases.join(', ')]))}
      <h3>Judge disagreements</h3>${disagreements.length === 0 ? '<p>none</p>'
        : table(['case', 'trial', 'passing judges', 'failing judges'],
          disagreements.map((item) => [item.case_id, String(item.trial), item.passing_judges.join(', '), item.failing_judges.join(', ')]))}`;

  const flakySection = `<h2>Flaky cases</h2>${flaky.length === 0 ? '<p>none</p>'
    : table(['case', 'trials', 'verdicts'],
      flaky.map((item) => [item.case_id, String(item.trials), JSON.stringify(item.verdicts)]))}`;

  // Business coverage needs the suite definition, which lives in the run plan.
  let businessSection = `<h2>Business coverage</h2>${NOT_MEASURED}`;
  try {
    const plan = JSON.parse(await readFile(join(runDir, 'plan.json'), 'utf8')) as { suite: Parameters<typeof coverageSuites>[0][number] };
    const coverage = coverageSuites([plan.suite]).suites[0];
    if (coverage !== undefined) {
      const rows: string[][] = [
        ...Object.entries(coverage.by_business_invariant ?? {}).map(([id, item]) =>
          ['invariant', id, `positive ${item.positive} / negative ${item.negative}`, item.covered ? 'covered' : 'gap']),
        ...Object.entries(coverage.by_business_transition ?? {}).map(([id, item]) =>
          ['transition', id, `${item.cases} case(s)`, item.covered ? 'covered' : 'gap']),
        ...Object.entries(coverage.by_business_rule ?? {}).map(([id, item]) =>
          ['rule', id, item.boundaries.map((boundary) => `${boundary.value}:${boundary.cases}`).join(' '), item.covered ? 'covered' : 'gap']),
      ];
      businessSection = `<h2>Business coverage</h2>${rows.length === 0
        ? '<p>suite declares no business model</p>'
        : table(['kind', 'id', 'coverage', 'status'], rows)}`;
    }
  } catch {
    // A missing or unreadable plan leaves the section at "not measured".
  }

  const body = report.results.map(caseSection).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>craft-eval report</title>
  <body style="font-family:ui-sans-serif,system-ui;max-width:960px;margin:2rem auto;padding:0 1rem">
  ${summary}${languageSection}${judgeSection}${flakySection}${businessSection}
  ${comparisonSection(extras.comparison)}${mutationSection(extras.mutation)}
  <h2>Cases</h2>${body}</body>`;
  await writeFile(outputPath, html, 'utf8');
  return outputPath;
}
