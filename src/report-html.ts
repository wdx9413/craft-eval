/** Zero-dependency static HTML report for a run directory. */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { reportRun, type RunReport, type CheckResult } from './evaluation.js';
import { coverageSuites } from './audit.js';

const NOT_MEASURED = '<p><em>not measured</em></p>';

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

export async function writeHtmlReport(runDir: string, outputPath: string): Promise<string> {
  const report = await reportRun(runDir);
  const flaky = report.flaky_cases ?? [];
  const judges = report.by_judge ?? {};
  const disagreements = report.judge_disagreements ?? [];

  const summary = `
  <h1>craft-eval run ${esc(report.run_id.slice(0, 12))}</h1>
  <p><b>${esc(report.suite_id)}</b> · ${esc(report.partition)} ·
  passed ${report.passed} / failed ${report.failed} / inconclusive ${report.inconclusive} /
  invalid ${report.invalid} / missing ${report.missing} / n.a. ${report.not_applicable ?? 0} /
  flaky ${flaky.length}</p>`;

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
  <h2>Cases</h2>${body}</body>`;
  await writeFile(outputPath, html, 'utf8');
  return outputPath;
}
