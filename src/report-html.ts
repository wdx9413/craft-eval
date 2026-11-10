/** Zero-dependency static HTML report for a run directory. */

import { writeFile } from 'node:fs/promises';

import { reportRun, type RunReport, type CheckResult } from './evaluation.js';

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
  const summary = `
  <h1>craft-eval run ${esc(report.run_id.slice(0, 12))}</h1>
  <p><b>${esc(report.suite_id)}</b> · ${esc(report.partition)} ·
  passed ${report.passed} / failed ${report.failed} / inconclusive ${report.inconclusive} /
  invalid ${report.invalid} / missing ${report.missing} / n.a. ${report.not_applicable ?? 0}</p>
  ${report.by_language === undefined ? '' : `<p>by language: <code>${esc(JSON.stringify(report.by_language))}</code></p>`}`;
  const body = report.results.map(caseSection).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>craft-eval report</title>
  <body style="font-family:ui-sans-serif,system-ui;max-width:960px;margin:2rem auto;padding:0 1rem">${summary}${body}</body>`;
  await writeFile(outputPath, html, 'utf8');
  return outputPath;
}
