import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRuns, loadSuite, reportRun, rescoreScripts, runSuite, signProbability } from '../src/evaluation.js';
import type { CaseResult, CheckResult } from '../src/evaluation.js';
import { main } from '../src/cli.js';
import { auditSuiteFiles } from '../src/audit.js';
import { coverageSuiteFiles } from '../src/audit.js';
import { attributeRun } from '../src/attribution.js';
import { writeHtmlReport } from '../src/report-html.js';
import { runMutations } from '../src/mutation.js';
import { calibrateJudge } from '../src/calibration.js';

const RUNTIME_KEYS = ['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'];

/** Asserting accessor: a run that produced no result is a broken run, not a soft miss. */
function only<T>(values: T[], description = 'result'): T {
  assert.equal(values.length, 1, `expected exactly one ${description}`);
  const value = values[0];
  assert.ok(value !== undefined, `expected one ${description}`);
  return value;
}

async function firstResult(runDir: string): Promise<CaseResult> {
  return only((await reportRun(runDir)).results, 'case result');
}

async function firstCheck(runDir: string): Promise<CheckResult> {
  return only((await firstResult(runDir)).checks, 'check result');
}

/**
 * The host shell may run Node inside an Electron wrapper, where process.execPath
 * points at the wrapper application instead of the Node binary. Adapters must be
 * launched with a real Node executable, so resolve one explicitly.
 */
function resolveNodeBinary(): string {
  if (process.env.CRAFT_EVAL_NODE_BINARY) {
    return process.env.CRAFT_EVAL_NODE_BINARY;
  }
  if (!process.versions.electron) {
    return process.execPath;
  }
  for (const directory of (process.env.PATH ?? '').split(';')) {
    if (!directory) {
      continue;
    }
    const candidate = `${directory.replace(/[\\/]+$/, '')}\\node.exe`;
    if (existsSync(candidate) && !candidate.includes('DSH Desktop')) {
      return candidate;
    }
  }
  throw new Error('no Node binary found for adapter execution');
}

const NODE_BINARY = resolveNodeBinary();

function runtime(): Record<string, string> {
  const value: Record<string, string> = {};
  for (const key of RUNTIME_KEYS) {
    value[key] = `${key}-fixed`;
  }
  return value;
}

function suiteDoc(kind: string, cases: unknown[], partition = 'held_out'): Record<string, unknown> {
  return {
    schema: 'craft-eval.eval.v1',
    suite_id: `${kind}-suite`,
    subject_kind: kind,
    partition,
    sanitized: true,
    approved_by: 'reviewer',
    cases,
  };
}

interface CaseOptions {
  checks?: unknown[];
  safety?: unknown[];
  [key: string]: unknown;
}

/**
 * Write a real skill directory into the workspace so cases can pin a binding the
 * evaluator resolves, rather than declaring a bare id that nothing checks.
 */
const SKILL_ID = 'answer-skill';

async function writeSkill(workspace: string, skillId = SKILL_ID): Promise<void> {
  const directory = join(workspace, 'skills', skillId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    ['---', `name: ${skillId}`, 'description: A test skill used by the evaluator suite.', '---', '', '# Body', ''].join('\n'),
    'utf8',
  );
}

/**
 * A local fake Host emits the same JSONL shapes as a real Codex/Claude CLI.
 * This exercises evaluator-owned parsing without making the test suite depend
 * on network access, credentials, or a particular model.
 */
async function writeFakeHost(workspace: string, kind: 'codex' | 'claude'): Promise<void> {
  const event =
    kind === 'codex'
      ? `{"type":"item.completed","item":{"type":"command_execution","command":"node host.mjs","aggregated_output":"","exit_code":0,"status":"completed"}}\n{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":4,"reasoning_output_tokens":2}}`
      : `{"type":"system","subtype":"init","model":"group/free","cwd":${JSON.stringify(workspace)}}\n{"type":"assistant","message":{"model":"observed-model","usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":4},"content":[{"type":"tool_use","name":"Skill","input":{"skill":"answer-skill"}},{"type":"tool_use","name":"Read","input":{"file_path":"SKILL.md"}}]}}\n{"type":"result","total_cost_usd":0.25,"usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":4},"modelUsage":{"observed-model":{"inputTokens":12}}}`;
  const withoutSkill =
    kind === 'claude'
      ? `{"type":"system","subtype":"init","model":"group/free","cwd":${JSON.stringify(workspace)}}\n{"type":"assistant","message":{"model":"observed-model","usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":4},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"SKILL.md"}}]}}\n{"type":"result","total_cost_usd":0.25,"usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":4},"modelUsage":{"observed-model":{"inputTokens":12}}}`
      : event;
  await writeFile(
    join(workspace, 'fake-host.mjs'),
    `import { execFileSync } from 'node:child_process';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  execFileSync(process.execPath, ['host.mjs'], { stdio: 'ignore' });
  const positive = process.env.CRAFT_EVAL_CASE_ID.startsWith('task-');
  const body = positive ? ${JSON.stringify(event)} : ${JSON.stringify(withoutSkill)};
  process.stdout.write(body + '\\n');
});
`,
    'utf8',
  );
}

function skillBinding(shouldTrigger: boolean, skillId = SKILL_ID): Record<string, unknown> {
  return { skill_id: skillId, skill_path: `skills/${skillId}`, should_trigger: shouldTrigger };
}

function caseDoc(id: string, options: CaseOptions = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id,
    argv: [NODE_BINARY, 'host.mjs'],
    timeout_s: 3,
    checks: options.checks ?? [{ id: 'exit', kind: 'exit_code', equals: 0 }],
    safety_checks: options.safety ?? [],
  };
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'checks' && key !== 'safety') {
      if (value === undefined) {
        delete base[key];
      } else {
        base[key] = value;
      }
    }
  }
  return base;
}

class Fixture {
  root!: string;
  workspace!: string;
  output!: string;
  runtimePath!: string;
  counter = 0;

  async setup(): Promise<void> {
    this.root = await mkdtemp(join(tmpdir(), 'craft-eval-test-'));
    this.workspace = join(this.root, 'workspace');
    await mkdir(this.workspace);
    this.output = join(this.root, 'runs');
    this.runtimePath = await write(this.root, 'runtime.json', runtime());
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  async project(script: string): Promise<void> {
    await writeFile(join(this.workspace, 'host.mjs'), script, 'utf8');
  }

  async runEval(kind: string, cases: unknown[], subjectEnv: Record<string, string> = {}, trials = 1): Promise<string> {
    this.counter += 1;
    const suitePath = await write(this.root, `${kind}-suite.json`, suiteDoc(kind, cases));
    const subjectPath = await write(this.root, `${kind}-${this.counter}.json`, {
      kind,
      id: `${kind}-subject`,
      version: 'v1',
      env: subjectEnv,
    });
    return runSuite(suitePath, subjectPath, this.runtimePath, this.workspace, this.output, { trials });
  }
}

async function runHostSuite(
  fx: Fixture,
  cases: unknown[],
  baselineEnv: Record<string, string>,
  candidateEnv: Record<string, string>,
): Promise<{ baseline: string; candidate: string }> {
  const suitePath = await write(fx.root, 'host-suite.json', suiteDoc('skill', cases));
  const host = { kind: 'claude', binary: NODE_BINARY, args_prefix: ['fake-host.mjs'], model: 'group/free' };
  const baselineSubject = await write(fx.root, 'host-baseline.json', {
    kind: 'skill',
    id: 'fake-claude',
    version: 'v1',
    env: baselineEnv,
    host,
  });
  const candidateSubject = await write(fx.root, 'host-candidate.json', {
    kind: 'skill',
    id: 'fake-claude',
    version: 'v2',
    env: candidateEnv,
    host,
  });
  return {
    baseline: await runSuite(suitePath, baselineSubject, fx.runtimePath, fx.workspace, fx.output),
    candidate: await runSuite(suitePath, candidateSubject, fx.runtimePath, fx.workspace, fx.output),
  };
}

async function write(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

async function captureStdout<T>(work: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    const value = await work();
    return { value, text: chunks.join('') };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

async function captureStderr<T>(work: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    const value = await work();
    return { value, text: chunks.join('') };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

/**
 * Directory links are the capability the guards actually rely on: jobs are
 * created as directory junctions on Windows, which need no elevation, whereas a
 * file symlink requires Developer Mode or admin rights. Both traverse the same
 * `lstat().isSymbolicLink()` check, so a junction exercises the guard.
 */
async function canCreateDirectoryLink(root: string): Promise<boolean> {
  const target = join(root, '.probe-dir');
  const link = join(root, '.probe-dir-link');
  try {
    await mkdir(target, { recursive: true });
    await symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  } finally {
    await rm(link, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
}

test('software executes in copy and reports observed failures', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { mkdirSync, writeFileSync } from 'node:fs';
const id = process.env.CRAFT_EVAL_CASE_ID;
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/state.json', JSON.stringify({ ok: id === 'fixed' }));
process.exit(id === 'fixed' ? 0 : 3);
`);
    const cases = [
      caseDoc('fixed', {
        checks: [
          { id: 'exit', kind: 'exit_code', equals: 0 },
          { id: 'state', kind: 'json_equals', path: 'outputs/state.json', key: 'ok', equals: true },
        ],
        safety: [{ id: 'artifact', kind: 'file_exists', path: 'outputs/state.json' }],
      }),
      caseDoc('broken'),
    ];
    const run = await fx.runEval('software', cases);
    const report = await reportRun(run);
    assert.deepEqual(
      [report.expected, report.recorded, report.passed, report.failed],
      [2, 2, 1, 1],
    );
    assert.equal(report.status, 'complete');
    assert.equal(existsSync(join(fx.workspace, 'outputs')), false);
    // Two cases run here; the first is the healthy one with a safety check.
    const healthy = report.results[0];
    assert.ok(healthy !== undefined);
    assert.equal(healthy.safety_verdict, 'passed');
    assert.ok(healthy.stdout_sha256);
    await captureStdout(async () => assert.equal(await main(['validate', join(fx.root, 'software-suite.json')]), 0));
    await captureStdout(async () => assert.equal(await main(['report', run]), 0));
  } finally {
    await fx.cleanup();
  }
});

test('agent checks environment state and completed host trace', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ task: { done: true } }));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [
  { source: 'host', task_run_id: id, event: 'tool.called' },
  { source: 'host', task_run_id: id, event: 'run.finished', cost_units: 2.5 },
];
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`);
    const checks = [
      { id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'task.done', equals: true },
      { id: 'tool', kind: 'trace_event', event: 'tool.called', present: true },
    ];
    const run = await fx.runEval('agent', [caseDoc('do-task', { checks })]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.verdict, result.task_verdict, result.cost_units, result.trace_complete],
      ['passed', 'passed', 2.5, true],
    );
  } finally {
    await fx.cleanup();
  }
});

test('missing terminal trace is inconclusive even when skill not selected', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'host', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'started' }) + '\\n');
`);
    const run = await fx.runEval('skill', [
      caseDoc('adjacent', { checks: [], skill: skillBinding(false) }),
    ]);
    const result = await firstResult(run);
    assert.deepEqual([result.verdict, result.trigger?.verdict, result.trigger?.evidence], ['inconclusive', 'inconclusive', 'unobserved']);
  } finally {
    await fx.cleanup();
  }
});

test('agent local argv checks do not require a host trace', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ done: true }));
`);
    const checks = [{ id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'done', equals: true }];
    const run = await fx.runEval('agent', [caseDoc('agent', { checks })]);
    const result = await firstResult(run);
    assert.deepEqual([result.task_verdict, result.verdict, result.trace_complete], ['passed', 'passed', false]);
  } finally {
    await fx.cleanup();
  }
});

test('skill paired gain requires evaluator-observed host events', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await writeFakeHost(fx.workspace, 'claude');
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
const enabled = process.env.SKILL_ENABLED === '1';
const positive = process.env.CRAFT_EVAL_CASE_ID.startsWith('task-');
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: positive ? enabled : true }));
`);
    const checks = [{ id: 'outcome', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }];
    const cases = [] as unknown[];
    for (let index = 0; index < 20; index += 1) {
      cases.push(
        caseDoc(`task-${index}`, {
          checks,
          skill: skillBinding(true),
          prompt: 'Do the task',
          argv: undefined,
        }),
      );
    }
    cases.push(caseDoc('adjacent', { checks: [], skill: skillBinding(false), prompt: 'Do not use the skill', argv: undefined }));
    const { baseline, candidate } = await runHostSuite(fx, cases, { SKILL_ENABLED: '0' }, { SKILL_ENABLED: '1' });
    const compared = await compareRuns(baseline, candidate);
    assert.deepEqual(
      [compared.measured_pairs, compared.candidate_wins, compared.candidate_trigger_failures],
      [20, 20, 0],
    );
    assert.equal(compared.skill_gain_supported, true);
    assert.ok((compared.one_sided_p ?? 1) < 0.05);
    assert.equal(compared.independent_task_runs, true);
    assert.equal(compared.gateway_observed_triggers, true);
    assert.equal(compared.unobserved_triggers, 0);
    const candidateResult = (await reportRun(candidate)).results.find((item) => item.case_id === 'task-0');
    assert.deepEqual(candidateResult?.host?.observed_models, ['observed-model']);
    assert.equal(candidateResult?.host?.requested_model, 'group/free');
    assert.equal(candidateResult?.host?.cost_usd, 0.25);
    await captureStdout(async () => assert.equal(await main(['compare', baseline, candidate, '--require-gain']), 0));
  } finally {
    await fx.cleanup();
  }
});

test('plan and result tampering or incomplete work cannot pass', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const run = await fx.runEval('software', [caseDoc('one'), caseDoc('two')], {}, 2);
    await unlink(join(run, 'results', 'one-1.json'));
    const report = await reportRun(run);
    assert.deepEqual([report.missing, report.status], [1, 'incomplete']);
    const other = await fx.runEval('software', [caseDoc('one'), caseDoc('two')], {}, 2);
    assert.equal((await compareRuns(run, other)).status, 'inconclusive');
    const changed = JSON.parse(await readFile(join(run, 'plan.json'), 'utf8'));
    changed.suite.cases[0].id = 'different';
    await write(run, 'plan.json', changed);
    await assert.rejects(reportRun(run), /invalid or changed/);
  } finally {
    await fx.cleanup();
  }
});

test('suite validation rejects unsafe or ambiguous contracts', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const base = suiteDoc('software', [caseDoc('a')]);
    const noCommand = caseDoc('a');
    delete noCommand.argv;
    const variants: [unknown, RegExp][] = [
      [{ ...base, schema: 'wrong' }, /schema/],
      [{ ...base, sanitized: false }, /sanitized/],
      [{ ...base, approved_by: '' }, /approved_by/],
      [{ ...base, partition: 'wrong' }, /partition/],
      [{ ...base, cases: [] }, /1\.\.1000/],
      [{ ...base, cases: [caseDoc('a'), caseDoc('a')] }, /unique/],
      [{ ...base, cases: [caseDoc('../bad')] }, /identifier/],
      [{ ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'file_exists', path: '../secret' }] })] }, /relative/],
      [{ ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'unknown' }] })] }, /unsupported/],
      [{ ...base, cases: [noCommand] }, /argv or prompt/],
      [{ ...base, cases: [{ ...caseDoc('a'), prompt: 'task' }] }, /both argv and prompt/],
    ];
    for (const [value, message] of variants) {
      await assert.rejects(loadSuite(await write(fx.root, 'invalid.json', value)), message);
    }
    const badSubject = await write(fx.root, 'bad-subject.json', {
      kind: 'software',
      id: 'build',
      version: 'v1',
      env: { CRAFT_EVAL_TASK_RUN_ID: 'fake' },
    });
    const goodSuite = await write(fx.root, 'valid.json', base);
    await assert.rejects(runSuite(goodSuite, badSubject, fx.runtimePath, fx.workspace, fx.output), /override/);
  } finally {
    await fx.cleanup();
  }
});

test('runtime mismatch and adapter errors are explicit', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const suitePath = await write(fx.root, 'suite.json', suiteDoc('software', [caseDoc('one')]));
    const subjectPath = await write(fx.root, 'subject.json', { kind: 'software', id: 'build', version: 'v1' });
    await assert.rejects(
      runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, join(fx.workspace, 'output')),
      /outside workspace/,
    );
    const badRuntime = await write(fx.root, 'bad-runtime.json', { model_digest: 'only' });
    await assert.rejects(
      runSuite(suitePath, subjectPath, badRuntime, fx.workspace, fx.output),
      /runtime must pin/,
    );
    const missing = caseDoc('missing');
    missing.argv = ['/definitely/missing/craft-eval-adapter'];
    const brokenSuite = await write(fx.root, 'broken-suite.json', suiteDoc('software', [missing]));
    const run = await runSuite(brokenSuite, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    assert.equal((await reportRun(run)).results[0]?.verdict, 'invalid');
  } finally {
    await fx.cleanup();
  }
});

test('timeout and untrusted trace cannot count as success', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`await new Promise((done) => setTimeout(done, 5000));
`);
    const slow = caseDoc('slow');
    slow.timeout_s = 0.5;
    const run = await fx.runEval('software', [slow]);
    const result = await firstResult(run);
    assert.deepEqual([result.issue, result.verdict], ['timeout', 'inconclusive']);
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'agent', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'run.finished' }) + '\\n');
`);
    await writeSkill(fx.workspace);
    const second = await fx.runEval('skill', [
      caseDoc('negative', { checks: [], skill: skillBinding(false) }),
    ]);
    assert.equal((await firstResult(second)).trigger?.verdict, 'inconclusive');
  } finally {
    await fx.cleanup();
  }
});

test('artifact links cannot read outside workspace', async (t) => {
  const fx = new Fixture();
  await fx.setup();
  try {
    if (!(await canCreateDirectoryLink(fx.root))) {
      t.skip('directory links are not creatable on this platform');
      return;
    }
    const outside = join(fx.root, 'secret');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'result.json'), '{"safe":true}', 'utf8');
    await fx.project(`import { mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
symlinkSync(process.env.OUTSIDE_DIR, 'outputs/linked', 'junction');
`);
    const run = await fx.runEval(
      'software',
      [
        caseDoc('leak', {
          checks: [
            { id: 'leak', kind: 'json_equals', path: 'outputs/linked/result.json', key: 'safe', equals: true },
          ],
        }),
      ],
      { OUTSIDE_DIR: outside },
    );
    const check = await firstCheck(run);
    assert.equal(check.passed, false, 'reading through a link must not pass');
    assert.equal((await firstResult(run)).task_verdict, 'failed');
  } finally {
    await fx.cleanup();
  }
});

test('contract rejects all invalid case and check shapes', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const base = suiteDoc('software', [caseDoc('a')]);
    const variants: [unknown, RegExp][] = [
      [[], /JSON object/],
      [{ ...base, cases: [null] }, /case must/],
      // Deliberately malformed: checks must be an array, so bypass the helper's typing.
      [{ ...base, cases: [{ ...caseDoc('a'), checks: 'not-an-array' }] }, /array/],
      [{ ...base, cases: [caseDoc('a', { checks: [null] })] }, /objects/],
      [{ ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'exit_code', equals: true }] })] }, /integer/],
      [
        { ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'json_equals', path: 'result.json', key: '' }] })] },
        /key/,
      ],
      [
        { ...base, cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'json_equals', path: 'result.json', key: 'a' }] })] },
        /equals/,
      ],
      [
        {
          ...base,
          cases: [caseDoc('a', { checks: [{ id: 'x', kind: 'trace_event', event: 'done', present: 1 }] })],
        },
        /boolean/,
      ],
      [
        {
          ...base,
          cases: [
            caseDoc('a', {
              checks: [
                { id: 'x', kind: 'exit_code', equals: 0 },
                { id: 'x', kind: 'exit_code', equals: 1 },
              ],
            }),
          ],
        },
        /unique/,
      ],
      [
        { ...base, cases: [caseDoc('a', { safety: [{ id: 'exit', kind: 'exit_code', equals: 0 }] })] },
        /distinct/,
      ],
      [{ ...base, cases: [{ ...caseDoc('a'), argv: [] }] }, /argv/],
      [{ ...base, cases: [{ ...caseDoc('a'), timeout_s: 0 }] }, /timeout/],
      [{ ...base, cases: [caseDoc('a', { checks: [] })] }, /task checks/],
      [suiteDoc('skill', [caseDoc('a')]), /skill binding/],
      [suiteDoc('skill', [{ ...caseDoc('a'), skill: { skill_id: 'x', skill_path: 'skills/x', should_trigger: 'yes' } }]), /boolean/],
      [suiteDoc('skill', [caseDoc('a', { checks: [], skill: skillBinding(true, 'mismatched') })]), /positive/],
      [
        {
          ...base,
          cases: [caseDoc('a', { checks: [{ id: 's', kind: 'script', path: 'check.mjs', pass_exit_codes: 'zero' }] })],
        },
        /pass_exit_codes/,
      ],
    ];
    for (const [value, message] of variants) {
      await assert.rejects(loadSuite(await write(fx.root, 'bad.json', value)), message);
    }
  } finally {
    await fx.cleanup();
  }
});

test('subject workspace trials and cli errors', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const suitePath = await write(fx.root, 'suite.json', suiteDoc('software', [caseDoc('a')]));
    const valid = { kind: 'software', id: 'subject', version: 'v1' };
    const subjectVariants: [unknown, RegExp][] = [
      [{ ...valid, kind: 'agent' }, /kind/],
      [{ ...valid, env: [] }, /env/],
      [{ ...valid, env: { 'BAD-NAME': 'x' } }, /env/],
    ];
    for (const [value, message] of subjectVariants) {
      await assert.rejects(
        runSuite(suitePath, await write(fx.root, 'subject.json', value), fx.runtimePath, fx.workspace, fx.output),
        message,
      );
    }
    const hostVariants: [unknown, RegExp][] = [
      [null, /object/],
      [{ kind: 'other', binary: 'host' }, /codex or claude/],
      [{ kind: 'codex', binary: '' }, /binary/],
      [{ kind: 'codex', binary: 'host', args_prefix: 'bad' }, /args_prefix/],
      [{ kind: 'codex', binary: 'host', args_prefix: [''] }, /args_prefix/],
      [{ kind: 'codex', binary: 'host', model: '' }, /model/],
      [{ kind: 'codex', binary: 'host', sandbox: 'unsafe' }, /sandbox/],
      [{ kind: 'codex', binary: 'host', env: [] }, /host\.env/],
      [{ kind: 'codex', binary: 'host', env: { 'BAD-NAME': 'x' } }, /host\.env/],
      [{ kind: 'codex', binary: 'host', env: { CRAFT_EVAL_RUN_ID: 'fake' } }, /override/],
      [{ kind: 'codex', binary: 'host', env: { LD_PRELOAD: 'fake' } }, /override/],
      [{ kind: 'codex', binary: 'host', typo: true }, /unsupported/],
    ];
    for (const [host, message] of hostVariants) {
      await assert.rejects(
        runSuite(
          suitePath,
          await write(fx.root, 'host-subject.json', { ...valid, host }),
          fx.runtimePath,
          fx.workspace,
          fx.output,
        ),
        message,
      );
    }
    const subjectPath = await write(fx.root, 'subject.json', valid);
    for (const trials of [0, true, 21]) {
      await assert.rejects(runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, { trials: trials as number }), /trials/);
    }
    await assert.rejects(
      runSuite(suitePath, subjectPath, fx.runtimePath, join(fx.root, 'missing'), fx.output),
      /workspace/,
    );
    // A workspace containing a directory link must be rejected before copying.
    if (await canCreateDirectoryLink(fx.root)) {
      await symlink(fx.root, join(fx.workspace, 'linked'), 'junction');
      await assert.rejects(runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output), /symlinks/);
    }
    const failed = await captureStderr(async () => main(['validate', join(fx.root, 'missing.json')]));
    assert.equal(failed.value, 2);
    for (const argv of [['run', '--unknown'], ['run', '--parallelism']]) {
      const parsed = await captureStderr(async () => main(argv));
      assert.equal(parsed.value, 2);
      assert.match(parsed.text, /unrecognized argument|--parallelism requires a value/);
    }
    for (const argv of [['validate'], ['report'], ['compare', 'only-one'], ['run']]) {
      const parsed = await captureStderr(async () => main(argv));
      assert.equal(parsed.value, 2);
      assert.match(parsed.text, /missing arguments/);
    }
  } finally {
    await fx.cleanup();
  }
});

test('parallel runs keep independent case results and reject unsafe bounds', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const path = 'active.txt';
const current = Number(readFileSync(path, 'utf8').trim());
writeFileSync(path, String(current + 1));
await new Promise((done) => setTimeout(done, 200));
appendFileSync('finished.txt', process.env.CRAFT_EVAL_CASE_ID + '\\n');
writeFileSync(path, String(Number(readFileSync(path, 'utf8').trim()) - 1));
`);
    await writeFile(join(fx.workspace, 'active.txt'), '0', 'utf8');
    const cases = Array.from({ length: 4 }, (_, index) => caseDoc(`parallel-${index}`));
    const suitePath = await write(fx.root, 'parallel-suite.json', suiteDoc('software', cases));
    const subjectPath = await write(fx.root, 'parallel-subject.json', {
      kind: 'software',
      id: 'parallel',
      version: 'v1',
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, {
      parallelism: 2,
    });
    assert.equal((await reportRun(run)).passed, 4);
    await assert.rejects(
      runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, { parallelism: 9 }),
      /parallelism/,
    );
    const numeric = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, 2);
    assert.equal((await reportRun(numeric)).expected, 8);
    const broken = await write(fx.root, 'broken-suite.json', suiteDoc('software', [caseDoc('bad', { checks: [] })]));
    await assert.rejects(
      runSuite(broken, subjectPath, fx.runtimePath, fx.workspace, fx.output),
      /needs task checks/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('cli failure gates return one without hiding the report', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(1);\n');
    const failed = await fx.runEval('software', [caseDoc('failed')]);
    const gated = await captureStdout(async () => main(['run', join(fx.root, 'software-suite.json'), join(fx.root, 'software-1.json'), fx.runtimePath, '--workspace', fx.workspace, '--output', fx.output, '--fail-on-failed']));
    assert.equal(gated.value, 1);
    assert.match(gated.text, /"status":"complete"/);
    const baseline = await fx.runEval('software', [caseDoc('failed')]);
    const comparison = await captureStdout(async () => main(['compare', failed, baseline, '--require-gain']));
    assert.equal(comparison.value, 1);
    assert.match(comparison.text, /"skill_gain_supported":false/);
  } finally {
    await fx.cleanup();
  }
});

test('--keep-traces exports raw capture files under the run directory', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.stdout.write("hello-stdout");\nprocess.exit(0);\n');
    // Seed the suite and subject files via the standard helper, then drive the
    // CLI so the end-to-end flag handling is exercised.
    const seeded = await fx.runEval('software', [caseDoc('writes-stdout')]);
    const captured = await captureStdout(async () =>
      main(['run', join(fx.root, 'software-suite.json'), join(fx.root, 'software-1.json'), fx.runtimePath,
        '--workspace', fx.workspace, '--output', fx.output, '--keep-traces']));
    assert.equal(captured.value, 0);
    const runDir = JSON.parse(captured.text).run_dir as string;
    const captureDir = join(runDir, 'captures', 'writes-stdout-1');
    const stdout = await readFile(join(captureDir, 'stdout'), 'utf8');
    assert.match(stdout, /hello-stdout/);
    // The seeded run (no flag) must not retain any captures.
    assert.ok(!existsSync(join(seeded, 'captures')));
  } finally {
    await fx.cleanup();
  }
});

test('script check surfaces stderr tail for diagnosis', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    await writeFile(
      join(fx.workspace, 'grade.mjs'),
      'console.log("grading-output"); console.error("missing marker: MAGIC"); process.exit(1);\n',
      'utf8',
    );
    const run = await fx.runEval('software', [
      caseDoc('scripted', { checks: [{ id: 'grade', kind: 'script', path: 'grade.mjs' }] }),
    ]);
    const result = await firstResult(run);
    const check = only(result.checks, 'script check');
    assert.equal(check.passed, false);
    assert.match(String(check.evidence.stderr_tail), /missing marker: MAGIC/);
    assert.match(String(check.evidence.stdout_tail), /grading-output/);
  } finally {
    await fx.cleanup();
  }
});

test('script checks receive the case id in their environment', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    await writeFile(
      join(fx.workspace, 'grade.mjs'),
      'if (process.env.CRAFT_EVAL_CASE_ID !== "env-case") {\n' +
        '  console.error("wrong case id: " + process.env.CRAFT_EVAL_CASE_ID);\n' +
        '  process.exit(1);\n' +
        '}\n',
      'utf8',
    );
    const run = await fx.runEval('software', [
      caseDoc('env-case', { checks: [{ id: 'g', kind: 'script', path: 'grade.mjs' }] }),
    ]);
    const check = only((await firstResult(run)).checks, 'script check');
    assert.equal(check.passed, true);
  } finally {
    await fx.cleanup();
  }
});

test('--keep-traces also exports inspected sandbox outputs', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(
      'import { mkdirSync, writeFileSync } from "node:fs";\n' +
        'mkdirSync("outputs", { recursive: true });\n' +
        'writeFileSync("outputs/answer.md", "artifact-body");\n',
    );
    const suitePath = await write(
      fx.root,
      'artifacts-suite.json',
      suiteDoc('software', [
        caseDoc('artifact', { checks: [{ id: 'file', kind: 'file_exists', path: 'outputs/answer.md' }] }),
      ]),
    );
    const subjectPath = await write(fx.root, 'artifacts-subject.json', {
      kind: 'software',
      id: 'artifact-subject',
      version: 'v1',
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, {
      keep_traces: true,
    });
    const exported = await readFile(join(run, 'captures', 'artifact-1', 'outputs', 'answer.md'), 'utf8');
    assert.equal(exported, 'artifact-body');
  } finally {
    await fx.cleanup();
  }
});

test('rescore re-runs script checks from captured outputs without the host', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(
      'import { mkdirSync, writeFileSync } from "node:fs";\n' +
        'mkdirSync("outputs", { recursive: true });\n' +
        'writeFileSync("outputs/answer.md", "body");\n',
    );
    await writeFile(join(fx.workspace, 'grade.mjs'), 'process.exit(1);\n', 'utf8');
    const suitePath = await write(
      fx.root,
      'rescore-suite.json',
      suiteDoc('software', [
        caseDoc('case-a', { checks: [{ id: 'g', kind: 'script', path: 'grade.mjs' }] }),
      ]),
    );
    const subjectPath = await write(fx.root, 'rescore-subject.json', {
      kind: 'software',
      id: 'rescore-subject',
      version: 'v1',
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, {
      keep_traces: true,
    });
    assert.equal((await reportRun(run)).failed, 1);
    // The captured outputs are unchanged; only the grader is fixed. Rescore must
    // reach a passing verdict without executing the subject again.
    await writeFile(join(fx.workspace, 'grade.mjs'), 'process.exit(0);\n', 'utf8');
    const rescored = await rescoreScripts(run, fx.workspace, join(fx.root, 'rescored'));
    const report = await reportRun(rescored);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 0);
  } finally {
    await fx.cleanup();
  }
});

test('rescore leaves not_applicable cases untouched', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const suitePath = await write(
      fx.root,
      'rescore-skip-suite.json',
      suiteDoc('software', [
        caseDoc('skip', {
          language: 'python',
          requires: { python_modules: ['definitely_missing_module_xyz'] },
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'rescore-skip-subject.json', {
      kind: 'software',
      id: 'rescore-skip-subject',
      version: 'v1',
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    assert.equal((await reportRun(run)).not_applicable, 1);
    const rescored = await rescoreScripts(run, fx.workspace, join(fx.root, 'rescored-skip'));
    const report = await reportRun(rescored);
    assert.equal(report.not_applicable, 1);
    assert.equal(report.failed, 0);
  } finally {
    await fx.cleanup();
  }
});

test('http_mock injects a local fixture API into the subject', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(
      'import { mkdirSync, writeFileSync } from "node:fs";\n' +
        'const response = await fetch(process.env.FIXTURE_API + "/price");\n' +
        'const data = await response.json();\n' +
        'mkdirSync("outputs", { recursive: true });\n' +
        'writeFileSync("outputs/result.json", JSON.stringify({ price: data.price }));\n',
    );
    const suitePath = await write(
      fx.root,
      'http-suite.json',
      suiteDoc('software', [
        caseDoc('http', {
          http_mock: [{ env: 'FIXTURE_API', routes: [{ path: '/price', body: { price: 42 } }] }],
          checks: [{ id: 'price', kind: 'json_equals', path: 'outputs/result.json', key: 'price', equals: 42 }],
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'http-subject.json', {
      kind: 'software',
      id: 'http-subject',
      version: 'v1',
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    assert.equal((await reportRun(run)).passed, 1);
  } finally {
    await fx.cleanup();
  }
});

test('json_equals failure keeps expected and observed values', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(
      'import { mkdirSync, writeFileSync } from "node:fs";\n' +
        'mkdirSync("outputs", { recursive: true });\n' +
        'writeFileSync("outputs/r.json", JSON.stringify({ ok: false }));\n',
    );
    const run = await fx.runEval('software', [
      caseDoc('c', { checks: [{ id: 'j', kind: 'json_equals', path: 'outputs/r.json', key: 'ok', equals: true }] }),
    ]);
    const check = only((await firstResult(run)).checks, 'check');
    assert.equal(check.passed, false);
    assert.equal(check.evidence.expected, true);
    assert.equal(check.evidence.actual, false);
  } finally {
    await fx.cleanup();
  }
});

test('unmet requires records not_applicable and attributes an external dependency gap', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const suitePath = await write(
      fx.root,
      'requires-suite.json',
      suiteDoc('software', [
        caseDoc('needs-python', {
          language: 'python',
          requires: { python_modules: ['definitely_missing_module_xyz'] },
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'requires-subject.json', {
      kind: 'software',
      id: 'requires-subject',
      version: 'v1',
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    const report = await reportRun(run);
    assert.equal(report.not_applicable, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.by_language?.['python']?.not_applicable, 1);
    const attribution = attributeRun(report);
    assert.equal(attribution.failures[0]?.category, 'external_dependency_missing');
  } finally {
    await fx.cleanup();
  }
});

test('assert-set threshold passes on weighted partial success', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const run = await fx.runEval('software', [
      caseDoc('partial', {
        threshold: 0.5,
        checks: [
          { id: 'a', kind: 'exit_code', equals: 0, weight: 3 },
          { id: 'b', kind: 'stdout_contains', value: 'impossible-marker', weight: 1 },
        ],
      }),
    ]);
    const result = await firstResult(run);
    assert.equal(result.verdict, 'passed');
    assert.equal(result.checks[1]?.weight, 1);
  } finally {
    await fx.cleanup();
  }
});

test('model_graded runs a pluggable judge command', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(
      'import { mkdirSync, writeFileSync } from "node:fs";\n' +
        'mkdirSync("outputs", { recursive: true });\n' +
        'writeFileSync("outputs/answer.md", "candidate answer");\n',
    );
    await writeFile(
      join(fx.workspace, 'judge.mjs'),
      'import { readFileSync } from "node:fs";\n' +
        'const answer = readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER, "utf8");\n' +
        'const score = answer.includes("candidate") ? 0.9 : 0.1;\n' +
        'console.log(JSON.stringify({ score, reason: "contains marker" }));\n',
      'utf8',
    );
    const run = await fx.runEval('software', [
      caseDoc('judged', {
        checks: [
          { id: 'quality', kind: 'model_graded', command: [NODE_BINARY, 'judge.mjs'], answer: 'outputs/answer.md', threshold: 0.8, judge: 'marker-judge' },
        ],
      }),
    ]);
    const check = only((await firstResult(run)).checks, 'judge check');
    assert.equal(check.passed, true);
    assert.equal(check.judge, 'marker-judge');
    assert.equal(check.evidence.score, 0.9);
  } finally {
    await fx.cleanup();
  }
});

test('coverage reports dimension gaps and report-html renders cases', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const suitePath = await write(fx.root, 'cov-suite.json', suiteDoc('software', [
      caseDoc('tagged', { category: 'core', risk: 'high', checks: [{ id: 'e', kind: 'exit_code', equals: 0 }] }),
      caseDoc('untagged'),
    ]));
    const coverage = await coverageSuiteFiles([suitePath]);
    const entry = only(coverage.suites, 'coverage suite');
    assert.equal(entry.cases, 2);
    assert.equal(entry.by_category.core, 1);
    // caseDoc adds a default exit_code check, so both cases contribute one.
    assert.equal(entry.by_check_kind.exit_code, 2);
    assert.ok(coverage.gaps.some((gap) => gap.includes('no category/risk/difficulty')));
    const run = await fx.runEval('software', [caseDoc('tagged')]);
    const htmlPath = join(fx.root, 'report.html');
    await writeHtmlReport(run, htmlPath);
    const html = await readFile(htmlPath, 'utf8');
    assert.match(html, /craft-eval run/);
    assert.match(html, /tagged/);
  } finally {
    await fx.cleanup();
  }
});

test('business model derives audit findings for invariants, transitions and incidents', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const suitePath = await write(fx.root, 'biz-suite.json', {
      ...suiteDoc('software', [
        caseDoc('positive', { category: 'core' }),
      ], 'development'),
      business: {
        invariants: [
          { id: 'inv-covered', statement: 'exit code is zero', positive_cases: ['positive'], negative_cases: [] },
          { id: 'inv-unknown', statement: 'refs a ghost case', positive_cases: ['ghost'], negative_cases: ['ghost'] },
        ],
        transitions: [
          { id: 't-idle', entity: 'order', from: 'created', to: 'paid', allowed: true, cases: ['positive'] },
          { id: 't-gap', entity: 'order', from: 'paid', to: 'refunded', allowed: true, cases: [] },
        ],
        incidents: [
          { id: 'inc-1', source: 'issue-42', case_ids: ['positive'] },
          { id: 'inc-2', source: 'issue-43', case_ids: [] },
        ],
      },
    });
    const audit = await auditSuiteFiles([suitePath]);
    const codes = audit.findings.map((item) => item.code);
    assert.ok(codes.includes('business_invariant_no_negative'));
    assert.ok(codes.includes('business_invariant_unknown_case'));
    assert.ok(codes.includes('business_transition_unexercised'));
    assert.ok(codes.includes('business_incident_unregressed'));
  } finally {
    await fx.cleanup();
  }
});

test('business rules flag uncovered boundaries and unknown case refs', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const suitePath = await write(fx.root, 'rules-suite.json', {
      ...suiteDoc('software', [caseDoc('c199'), caseDoc('c201')], 'development'),
      business: {
        rules: [
          {
            id: 'coupon-threshold',
            statement: '满 200 减 30 仅在商品金额 >= 200 时可用',
            parameter: 'cart_amount',
            boundaries: [
              { value: 199, cases: ['c199'] },
              { value: 200, cases: [] },
              { value: 201, cases: ['c201', 'ghost'] },
            ],
          },
        ],
      },
    });
    const audit = await auditSuiteFiles([suitePath]);
    const codes = audit.findings.map((item) => item.code);
    assert.ok(codes.includes('business_rule_boundary_uncovered'));
    assert.ok(codes.includes('business_rule_unknown_case'));
  } finally {
    await fx.cleanup();
  }
});

test('mutation counts killed and surviving injected defects', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // Baseline doubles as the --workspace: mutation edits host.mjs in a copy of
    // this directory, and the suite runs that copy's host.mjs via subject env.
    const baseline = join(fx.root, 'baseline');
    await mkdir(baseline, { recursive: true });
    await writeFile(
      join(baseline, 'host.mjs'),
      'const ok = true;\nif (ok) { process.exit(0); } else { process.exit(1); }\n',
      'utf8',
    );
    await writeFile(
      join(baseline, 'subject.json'),
      JSON.stringify({ kind: 'software', id: 'mutant-subject', version: 'v1' }),
      'utf8',
    );
    const suitePath = await write(fx.root, 'mut-suite.json', suiteDoc('software', [
      caseDoc('must-pass', { argv: [NODE_BINARY, 'host.mjs'], in_place: false, checks: [{ id: 'e', kind: 'exit_code', equals: 0 }] }),
    ], 'development'));
    // Case argv points at the workspace copy; the mutation flips a flag in the
    // subject copy, so drive via workspace host.mjs importing nothing from it.
    // Simpler: make the case run the mutated file directly through driver env.
    const manifestPath = await write(fx.root, 'mut-manifest.json', {
      baseline_dir: baseline,
      mutations: [
        { id: 'flip-ok', file: 'host.mjs', find: 'const ok = true;', replace: 'const ok = false;', should_fail: true },
        { id: 'comment-only', file: 'host.mjs', find: 'const ok = true;', replace: 'const ok = true; // noop', should_fail: false },
      ],
    });
    // runMutations passes the mutated copy dir as the subject path; our fixture
    // suite cases run `[NODE_BINARY, host.mjs]` from the workspace. To make the
    // mutated host.mjs the one that runs, the subject copy also contains the
    // workspace files, and we point --workspace at the mutated copy.
    const report = await runMutations(manifestPath, suitePath, fx.runtimePath, baseline, join(fx.root, 'mut-out'));
    assert.equal(report.total, 2);
    assert.equal(report.killed, 1);
    assert.equal(report.survived, 1);
    assert.equal(report.mutation_score, 0.5);
  } finally {
    await fx.cleanup();
  }
});

test('cli rejects unsupported workspace-mode values', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project('process.exit(0);\n');
    const errored = await captureStderr(async () =>
      main(['run', join(fx.root, 'software-suite.json'), join(fx.root, 'software-1.json'), fx.runtimePath,
        '--workspace', fx.workspace, '--output', fx.output, '--workspace-mode', 'bogus']));
    assert.notEqual(errored.value, 0);
    assert.match(errored.text, /workspace-mode must be isolated or shared/);
  } finally {
    await fx.cleanup();
  }
});

test('calibrate measures gold-set accuracy and self-consistency', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // Gold samples resolve relative to the manifest directory.
    await writeFile(join(fx.root, 'good.md'), 'the answer mentions the marker', 'utf8');
    await writeFile(join(fx.root, 'bad.md'), 'nothing relevant here', 'utf8');
    await writeFile(
      join(fx.workspace, 'judge.mjs'),
      'import { readFileSync } from "node:fs";\n' +
        'const answer = readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER, "utf8");\n' +
        'console.log(JSON.stringify({ score: answer.includes("marker") ? 0.9 : 0.2 }));\n',
      'utf8',
    );
    const manifest = await write(fx.root, 'calib.json', {
      command: [NODE_BINARY, join(fx.workspace, 'judge.mjs')],
      repeats: 3,
      samples: [
        { id: 'gold-pass', answer: 'good.md', expected: 'passed', threshold: 0.5 },
        { id: 'gold-fail', answer: 'bad.md', expected: 'failed', threshold: 0.5 },
      ],
    });
    const report = await calibrateJudge(manifest);
    assert.equal(report.samples, 2);
    assert.equal(report.accuracy, 1);
    assert.equal(report.consistency, 1);
  } finally {
    await fx.cleanup();
  }
});

test('calibrate reports inconsistency for a flaky judge', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeFile(join(fx.root, 'answer.md'), 'content', 'utf8');
    await writeFile(
      join(fx.workspace, 'flaky.mjs'),
      'console.log(JSON.stringify({ score: Math.random() > 0.5 ? 0.9 : 0.1 }));\n',
      'utf8',
    );
    const manifest = await write(fx.root, 'calib-flaky.json', {
      command: [NODE_BINARY, join(fx.workspace, 'flaky.mjs')],
      repeats: 8,
      samples: [{ id: 's', answer: 'answer.md', expected: 'passed', threshold: 0.5 }],
    });
    const report = await calibrateJudge(manifest);
    assert.equal(report.samples, 1);
    assert.ok(report.consistency !== null && report.consistency < 1, 'flaky judge must not be perfectly consistent');
  } finally {
    await fx.cleanup();
  }
});

test('audit warns on insufficient skill gain sample size', async () => {
  // skill_gain_supported needs >=20 positives and >=1 negative; a tiny suite
  // must be flagged so authors size their held-out set before a meaningless run.
  const fx = new Fixture();
  await fx.setup();
  try {
    const suitePath = await write(fx.root, 'skill-suite.json', suiteDoc('skill', [
      caseDoc('positive', { skill: skillBinding(true) }),
    ], 'held_out'));
    const result = await auditSuiteFiles([suitePath]);
    const codes = result.findings.map((item) => item.code);
    assert.ok(codes.includes('skill_gain_sample_insufficient'));
    assert.ok(codes.includes('skill_gain_no_negative'));
    // A well-sized suite avoids the sample warnings but may still surface
    // held-out review/independence warnings, which are a different gate.
    const cases = [];
    for (let index = 0; index < 20; index += 1) {
      cases.push(caseDoc(`positive-${index}`, { skill: skillBinding(true) }));
    }
    cases.push(caseDoc('negative', { skill: skillBinding(false) }));
    const sizedPath = await write(fx.root, 'skill-sized.json', suiteDoc('skill', cases, 'held_out'));
    const sized = await auditSuiteFiles([sizedPath]);
    const sizedCodes = sized.findings.map((item) => item.code);
    assert.ok(!sizedCodes.includes('skill_gain_sample_insufficient'));
    assert.ok(!sizedCodes.includes('skill_gain_no_negative'));
  } finally {
    await fx.cleanup();
  }
});

test('audit warns when declarative boundaries are not enforced by a sandbox', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const suitePath = await write(fx.root, 'bounded.json', {
      ...suiteDoc('software', [caseDoc('c')], 'development'),
      boundaries: { network: 'deny' },
    });
    const result = await auditSuiteFiles([suitePath]);
    assert.ok(result.findings.some((item) => item.code === 'boundaries_declared_unenforced'));
  } finally {
    await fx.cleanup();
  }
});

test('audit warns on subject_kind without a dedicated execution path', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const suitePath = await write(fx.root, 'other-kind.json', suiteDoc('robot', [caseDoc('c')], 'development'));
    const result = await auditSuiteFiles([suitePath]);
    assert.ok(result.findings.some((item) => item.code === 'subject_kind_unrecognized'));
  } finally {
    await fx.cleanup();
  }
});

test('artifact and trace failure modes', async (t) => {
  const fx = new Fixture();
  await fx.setup();
  try {
    if (!(await canCreateDirectoryLink(fx.root))) {
      t.skip('directory links are not creatable on this platform');
      return;
    }
    // A link pointing outside the workspace must never satisfy file_exists.
    await mkdir(join(fx.root, 'outside-dir'), { recursive: true });
    await writeFile(join(fx.root, 'outside-dir', 'linked.json'), '{}', 'utf8');
    await fx.project(`import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('outputs/folder', { recursive: true });
writeFileSync('outputs/folder/result.json', '{bad json');
symlinkSync(process.env.OUTSIDE_DIR, 'outputs/folder/linked', 'junction');
`);
    const checks = [
      { id: 'missing', kind: 'file_exists', path: 'outputs/missing' },
      { id: 'bad', kind: 'json_equals', path: 'outputs/folder/result.json', key: 'x', equals: true },
      { id: 'linked', kind: 'file_exists', path: 'outputs/folder/linked/linked.json' },
      { id: 'no-trace', kind: 'trace_event', event: 'tool.called', present: false },
    ];
    const run = await fx.runEval(
      'software',
      [caseDoc('bad', { checks })],
      { OUTSIDE_DIR: join(fx.root, 'outside-dir') },
    );
    const result = await firstResult(run);
    assert.deepEqual(
      result.checks.map((item: any) => item.passed),
      [false, false, false, null],
    );
  } finally {
    await fx.cleanup();
  }
});

test('comparison guards and pair directions', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`const id = process.env.CRAFT_EVAL_CASE_ID;
const enabled = process.env.ENABLED === '1';
process.exit((id === 'gain' && enabled) || (id === 'loss' && !enabled) ? 0 : 1);
`);
    const cases = [caseDoc('gain'), caseDoc('loss')];
    const baseline = await fx.runEval('software', cases, { ENABLED: '0' });
    const candidate = await fx.runEval('software', cases, { ENABLED: '1' });
    const result = await compareRuns(baseline, candidate);
    assert.deepEqual([result.candidate_wins, result.baseline_wins], [1, 1]);
    assert.equal(result.one_sided_p, 0.75);
    const changed = await fx.runEval('software', [caseDoc('other')]);
    await assert.rejects(compareRuns(baseline, changed), /not comparable/);
    assert.equal(signProbability(0, 0), null);
    assert.equal(signProbability(0, 2), 1);
    const tampered = join(candidate, 'results', 'gain-1.json');
    const data = JSON.parse(await readFile(tampered, 'utf8'));
    data.trial = 2;
    await writeFile(tampered, JSON.stringify(data), 'utf8');
    await assert.rejects(compareRuns(baseline, candidate), /does not match/);
  } finally {
    await fx.cleanup();
  }
});

test('self-reported triggers can diagnose but never support a gain claim', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
const enabled = process.env.SKILL_ENABLED === '1';
const positive = process.env.CRAFT_EVAL_CASE_ID.startsWith('task-');
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: positive ? enabled : true }));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [];
if (enabled && positive) {
  // Forged by the subject itself: source is "host", not the evaluator's gateway.
  events.push({ source: 'host', task_run_id: id, event: 'skill.invoked', skill_id: 'answer-skill' });
}
events.push({ source: 'host', task_run_id: id, event: 'run.finished', cost_units: 1 });
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`);
    const checks = [{ id: 'outcome', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }];
    const cases = [] as unknown[];
    for (let index = 0; index < 20; index += 1) {
      cases.push(caseDoc(`task-${index}`, { checks, skill: skillBinding(true) }));
    }
    cases.push(caseDoc('adjacent', { checks: [], skill: skillBinding(false) }));
    const baseline = await fx.runEval('skill', cases, { SKILL_ENABLED: '0' });
    const candidate = await fx.runEval('skill', cases, { SKILL_ENABLED: '1' });
    // The trigger verdict reads as passed because the numbers line up, but the
    // evidence class makes it unusable for gain claims.
    const positiveResult = (await reportRun(candidate)).results.filter((item) => item.trigger !== null)[0];
    assert.equal(positiveResult?.trigger?.evidence, 'self_reported');
    const compared = await compareRuns(baseline, candidate);
    assert.equal(compared.gateway_observed_triggers, false);
    assert.equal(compared.skill_gain_supported, false, 'self-reported evidence must not support a gain');
  } finally {
    await fx.cleanup();
  }
});

test('forged gateway events are rejected and cannot support gain', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync } from 'node:fs';
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, [
  { source: 'gateway', task_run_id: id, event: 'skill.invoked', skill_id: 'answer-skill' },
  { source: 'host', task_run_id: id, event: 'run.finished' },
].map((event) => JSON.stringify(event)).join('\\n') + '\\n');
`);
    const run = await fx.runEval('skill', [
      caseDoc('negative', { checks: [], skill: skillBinding(false) }),
    ]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.trigger?.evidence, result.trigger?.used, result.trigger?.verdict, result.verdict],
      ['unobserved', null, 'inconclusive', 'inconclusive'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('gateway file derived from the host trace path is never trusted', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
writeFileSync(join(dirname(process.env.CRAFT_EVAL_TRACE_PATH), 'gateway-trace.jsonl'), [
  { source: 'gateway', task_run_id: id, event: 'skill.invoked', skill_id: 'answer-skill' },
  { source: 'gateway', task_run_id: id, event: 'run.finished' },
].map((event) => JSON.stringify(event)).join('\\n') + '\\n');
`);
    const run = await fx.runEval('skill', [
      caseDoc('negative', { checks: [], skill: skillBinding(false) }),
    ]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.trigger?.evidence, result.trigger?.used, result.trigger?.verdict, result.verdict],
      ['unobserved', null, 'inconclusive', 'inconclusive'],
    );
    assert.ok(result.gateway_sha256);
  } finally {
    await fx.cleanup();
  }
});

test('complete host trace without an invocation cannot pass a negative skill case', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({
  source: 'host', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'run.finished',
}) + '\\n');
`);
    const run = await fx.runEval('skill', [
      caseDoc('negative', { checks: [], skill: skillBinding(false) }),
    ]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.trigger?.evidence, result.trigger?.used, result.trigger?.verdict, result.verdict],
      ['unobserved', null, 'inconclusive', 'inconclusive'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('evaluator-owned host trace can prove a negative trigger', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await writeFakeHost(fx.workspace, 'claude');
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync('outputs/ok', 'ok');
`);
    const suite = suiteDoc('skill', [
      caseDoc('negative', { checks: [], skill: skillBinding(false), prompt: 'Do not use the skill', argv: undefined }),
    ]);
    const suitePath = await write(fx.root, 'negative-suite.json', suite);
    const subjectPath = await write(fx.root, 'negative-subject.json', {
      kind: 'skill',
      id: 'fake-claude',
      version: 'v1',
      host: { kind: 'claude', binary: NODE_BINARY, args_prefix: ['fake-host.mjs'] },
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.trigger?.evidence, result.trigger?.used, result.trigger?.verdict, result.verdict],
      ['gateway', false, 'passed', 'passed'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('host JSONL failures are inconclusive rather than successful', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    const suite = suiteDoc('skill', [
      caseDoc('negative', {
        checks: [],
        skill: skillBinding(false),
        prompt: 'Do not use the skill',
        argv: undefined,
      }),
    ]);
    const suitePath = await write(fx.root, 'host-jsonl-suite.json', suite);
    const subjectPath = await write(fx.root, 'host-jsonl-subject.json', {
      kind: 'skill',
      id: 'fake-claude',
      version: 'v1',
      host: { kind: 'claude', binary: NODE_BINARY, args_prefix: ['invalid-host.mjs'] },
    });
    await writeFile(join(fx.workspace, 'invalid-host.mjs'), "process.stdout.write('not json\\n');\n", 'utf8');
    const invalid = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    const invalidResult = await firstResult(invalid);
    assert.deepEqual(
      [invalidResult.trigger?.evidence, invalidResult.trigger?.verdict, invalidResult.verdict, invalidResult.host],
      ['unobserved', 'inconclusive', 'inconclusive', null],
    );

    await writeFile(
      join(fx.workspace, 'invalid-host.mjs'),
      `process.stdout.write(JSON.stringify({ type: 'assistant', message: { model: 'observed-model', content: [] } }) + '\\n');\n`,
      'utf8',
    );
    const incomplete = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    const incompleteResult = await firstResult(incomplete);
    assert.deepEqual(
      [incompleteResult.trigger?.evidence, incompleteResult.trigger?.verdict, incompleteResult.verdict],
      ['unobserved', 'inconclusive', 'inconclusive'],
    );
    assert.equal(incompleteResult.host?.adapter, 'claude');
  } finally {
    await fx.cleanup();
  }
});

test('host launch and prompt contract failures are explicit', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    const hostCase = caseDoc('host-task', {
      checks: [],
      skill: skillBinding(false),
      prompt: 'Do not use the skill',
      argv: undefined,
    });
    const suitePath = await write(fx.root, 'launch-suite.json', suiteDoc('skill', [hostCase]));
    const missingHost = await write(fx.root, 'missing-host.json', {
      kind: 'skill',
      id: 'fake-claude',
      version: 'v1',
      host: { kind: 'claude', binary: '/definitely/missing/craft-eval-host' },
    });
    const launched = await firstResult(
      await runSuite(suitePath, missingHost, fx.runtimePath, fx.workspace, fx.output),
    );
    assert.equal(launched.verdict, 'invalid');
    assert.match(launched.issue ?? '', /adapter_error/);

    const plainSubject = await write(fx.root, 'plain-subject.json', {
      kind: 'skill',
      id: 'plain',
      version: 'v1',
    });
    await assert.rejects(
      runSuite(suitePath, plainSubject, fx.runtimePath, fx.workspace, fx.output),
      /prompt requires subject\.host/,
    );

    const plainCase = caseDoc('plain-case', {
      argv: [NODE_BINARY, 'plain.mjs'],
      checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
      skill: skillBinding(true),
    });
    await writeFile(
      join(fx.workspace, 'plain.mjs'),
      `import { appendFileSync } from 'node:fs';
const task = process.env.CRAFT_EVAL_TASK_RUN_ID;
appendFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'host', task_run_id: task, event: 'skill.invoked', skill_id: '${SKILL_ID}' }) + '\\n');
appendFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'host', task_run_id: task, event: 'run.finished' }) + '\\n');
`,
      'utf8',
    );
    const plainSuite = await write(fx.root, 'plain-suite.json', suiteDoc('skill', [plainCase]));
    const localStep = await firstResult(
      await runSuite(plainSuite, missingHost, fx.runtimePath, fx.workspace, fx.output),
    );
    assert.equal(localStep.verdict, 'passed');
  } finally {
    await fx.cleanup();
  }
});

test('oversized host output is rejected instead of partially parsed', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await writeFile(
      join(fx.workspace, 'oversized-host.mjs'),
      `process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
});
`,
      'utf8',
    );
    const suitePath = await write(
      fx.root,
      'oversized-suite.json',
      suiteDoc('skill', [
        caseDoc('negative', {
          checks: [],
          skill: skillBinding(false),
          prompt: 'Do not use the skill',
          argv: undefined,
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'oversized-subject.json', {
      kind: 'skill',
      id: 'fake-claude',
      version: 'v1',
      host: { kind: 'claude', binary: NODE_BINARY, args_prefix: ['oversized-host.mjs'] },
    });
    const result = await firstResult(
      await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output),
    );
    assert.deepEqual(
      [result.trigger?.evidence, result.trigger?.verdict, result.verdict, result.host],
      ['unobserved', 'inconclusive', 'inconclusive', null],
    );
  } finally {
    await fx.cleanup();
  }
});

test('claude result usage falls back to assistant usage', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await writeFile(
      join(fx.workspace, 'fallback-host.mjs'),
      `process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write([
    ${JSON.stringify(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'observed-model',
          usage: { input_tokens: 7, cache_read_input_tokens: 2, output_tokens: 3 },
          content: [],
        },
      }),
    )},
    ${JSON.stringify(JSON.stringify({ type: 'result', total_cost_usd: 0.01, modelUsage: { 'observed-model': {} } }))},
  ].join('\\n') + '\\n');
});
`,
      'utf8',
    );
    const suitePath = await write(
      fx.root,
      'fallback-suite.json',
      suiteDoc('skill', [
        caseDoc('negative', {
          checks: [],
          skill: skillBinding(false),
          prompt: 'Do not use the skill',
          argv: undefined,
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'fallback-subject.json', {
      kind: 'skill',
      id: 'fake-claude',
      version: 'v1',
      host: { kind: 'claude', binary: NODE_BINARY, args_prefix: ['fallback-host.mjs'] },
    });
    const result = await firstResult(
      await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output),
    );
    assert.deepEqual(
      [
        result.host?.input_tokens,
        result.host?.cached_input_tokens,
        result.host?.output_tokens,
        result.host?.cost_usd,
      ],
      [7, 2, 3, 0.01],
    );
  } finally {
    await fx.cleanup();
  }
});

test('codex host events are parsed but skill invocation stays unobserved', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await writeFakeHost(fx.workspace, 'codex');
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: true }));
`);
    const suite = suiteDoc('agent', [
      caseDoc('codex-task', {
        prompt: 'Do the task',
        argv: undefined,
        checks: [{ id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }],
      }),
    ]);
    const suitePath = await write(fx.root, 'codex-suite.json', suite);
    const subjectPath = await write(fx.root, 'codex-subject.json', {
      kind: 'agent',
      id: 'fake-codex',
      version: 'v1',
      host: { kind: 'codex', binary: NODE_BINARY, args_prefix: ['fake-host.mjs'], model: 'group/free' },
    });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    const result = await firstResult(run);
    assert.equal(result.verdict, 'passed');
    assert.equal(result.host?.adapter, 'codex');
    assert.equal(result.host?.input_tokens, 12);
    assert.equal(result.host?.cost_usd, null);
    assert.equal(result.host?.requested_model, 'group/free');
    assert.deepEqual(result.host?.observed_models, []);
  } finally {
    await fx.cleanup();
  }
});

test('codex mcp tool calls are counted from evaluator-owned events', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeFile(
      join(fx.workspace, 'mcp-host.mjs'),
      `import { mkdirSync, writeFileSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => {
  mkdirSync('outputs', { recursive: true });
  writeFileSync('outputs/result.json', JSON.stringify({ ok: true }));
  process.stdout.write([
    ${JSON.stringify(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'mcp_tool_call', tool: 'lookup', status: 'completed' },
      }),
    )},
    ${JSON.stringify(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 0 },
      }),
    )},
  ].join('\\n') + '\\n');
});
`,
      'utf8',
    );
    const suitePath = await write(
      fx.root,
      'mcp-host-suite.json',
      suiteDoc('agent', [
        caseDoc('mcp-task', {
          prompt: 'Use the tool',
          argv: undefined,
          checks: [
            { id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true },
            { id: 'tool', kind: 'trace_event', event: 'tool.called', present: true },
          ],
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'mcp-host-subject.json', {
      kind: 'agent',
      id: 'fake-codex',
      version: 'v1',
      host: { kind: 'codex', binary: NODE_BINARY, args_prefix: ['mcp-host.mjs'] },
    });
    const result = await firstResult(
      await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output),
    );
    assert.deepEqual([result.verdict, result.host?.tool_calls], ['passed', 1]);
  } finally {
    await fx.cleanup();
  }
});

test('codex cannot prove skill triggers without an explicit invocation event', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await writeSkill(fx.workspace);
    await writeFakeHost(fx.workspace, 'codex');
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: true }));
`);
    const suitePath = await write(
      fx.root,
      'codex-skill-suite.json',
      suiteDoc('skill', [
        caseDoc('task-codex', {
          prompt: 'Use the skill',
          argv: undefined,
          skill: skillBinding(true),
          checks: [{ id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }],
        }),
      ]),
    );
    const subjectPath = await write(fx.root, 'codex-skill-subject.json', {
      kind: 'skill',
      id: 'fake-codex',
      version: 'v1',
      host: { kind: 'codex', binary: NODE_BINARY, args_prefix: ['fake-host.mjs'] },
    });
    const result = await firstResult(
      await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output),
    );
    assert.deepEqual(
      [result.trigger?.evidence, result.trigger?.used, result.trigger?.verdict, result.verdict],
      ['unobserved', null, 'inconclusive', 'inconclusive'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('script checks grade by exit code and classify failures', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: true }));
const script = process.env.CRAFT_EVAL_CASE_ID === 'passing'
  ? "import { writeFileSync } from 'node:fs'; writeFileSync('graded.txt', 'pass'); process.exit(0);"
  : "process.exit(2);";
writeFileSync('grade.mjs', script);
`);
    const scriptCheck = { id: 'grade', kind: 'script', path: 'grade.mjs' };
    const passing = await fx.runEval('software', [caseDoc('passing', { checks: [scriptCheck] })]);
    const passingCheck = await firstCheck(passing);
    assert.deepEqual([passingCheck.passed, passingCheck.reason], [true, 'ok']);
    // The failing case must still exit 0 so the script check alone decides.
    const failingSuite = await fx.runEval(
      'software',
      [caseDoc('failing', { checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }, scriptCheck] })],
    );
    const failingCheck = (await reportRun(failingSuite)).results[0]?.checks.find((item) => item.id === 'grade');
    assert.deepEqual([failingCheck?.passed, failingCheck?.reason, failingCheck?.evidence.exit_code], [false, 'script_failed', 2]);
    const missing = await fx.runEval('software', [
      caseDoc('missing', { checks: [{ id: 'grade', kind: 'script', path: 'nope/grade.mjs' }] }),
    ]);
    const missingCheck = await firstCheck(missing);
    assert.deepEqual([missingCheck.passed, missingCheck.reason], [false, 'not_found']);
    const accepted = { id: 'grade', kind: 'script', path: 'grade.mjs', pass_exit_codes: [0, 2] };
    const custom = await fx.runEval(
      'software',
      [caseDoc('failing', { checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }, accepted] })],
    );
    assert.equal(((await reportRun(custom)).results[0]?.checks.find((item) => item.id === 'grade'))?.passed, true);
  } finally {
    await fx.cleanup();
  }
});

test('development suite and command entry points', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`process.exit(0);
`);
    const suitePath = await write(fx.root, 'development.json', suiteDoc('software', [caseDoc('one')], 'development'));
    const subjectPath = await write(fx.root, 'subject.json', { kind: 'software', id: 'build', version: 'v1' });
    assert.equal((await loadSuite(suitePath)).partition, 'development');
    const captured = await captureStdout(async () =>
      main([
        'run',
        suitePath,
        subjectPath,
        fx.runtimePath,
        '--workspace',
        fx.workspace,
        '--output',
        fx.output,
      ]),
    );
    assert.equal(captured.value, 0);
    const runDir = JSON.parse(captured.text).run_dir as string;
    assert.equal((await reportRun(runDir)).passed, 1);
    const cli = spawnSync(NODE_BINARY, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'validate', suitePath], {
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
  } finally {
    await fx.cleanup();
  }
});

test('mocked mcp servers serve tools and tool_call checks grade from evaluator evidence', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // The host acts as a real MCP client: it reads the evaluator's server
    // descriptor, connects over stdio, initializes, lists tools and calls one.
    await fx.project(`import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const servers = JSON.parse(process.env.CRAFT_EVAL_MCP);
const server = servers[0];
mkdirSync('outputs', { recursive: true });

const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 1;
function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\\n');
  });
}
child.stdout.setEncoding('utf8');
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-host', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
const listed = await request('tools/list', {});
const called = await request('tools/call', { name: 'lookup', arguments: { q: 'craft' } });
const wrongArgs = await request('tools/call', { name: 'lookup', arguments: { q: 'other' } });

writeFileSync('outputs/mcp-result.json', JSON.stringify({
  tools: listed.result?.tools?.map((t) => t.name) ?? [],
  call_ok: !called.result?.isError,
  call_text: called.result?.content?.[0]?.text ?? '',
  wrong_call_ok: !wrongArgs.result?.isError,
}));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [
  { source: 'host', task_run_id: id, event: 'tool.called' },
  { source: 'host', task_run_id: id, event: 'run.finished', cost_units: 1 },
];
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
child.kill();
`);
    const mcp = [
      {
        name: 'search',
        tools: [
          {
            name: 'lookup',
            description: 'Look up a term',
            input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
            response: { content: [{ type: 'text', text: 'found:1' }] },
          },
        ],
      },
    ];
    const checks = [
      { id: 'result', kind: 'json_equals', path: 'outputs/mcp-result.json', key: 'call_ok', equals: true },
      { id: 'served', kind: 'json_equals', path: 'outputs/mcp-result.json', key: 'tools', equals: ['lookup'] },
      { id: 'called', kind: 'tool_call', server: 'search', tool: 'lookup', called: true },
      { id: 'args', kind: 'tool_call', server: 'search', tool: 'lookup', called: true, with_arguments: { q: 'craft' } },
      { id: 'not-called', kind: 'tool_call', server: 'search', tool: 'missing-tool', called: false },
    ];
    const run = await fx.runEval('agent', [caseDoc('use-mcp', { checks, mcp })]);
    const result = await firstResult(run);
    assert.deepEqual(
      [result.verdict, result.checks.map((item) => item.passed)],
      ['passed', [true, true, true, true, true]],
    );
    const argsCheck = result.checks.find((item) => item.id === 'args');
    assert.equal(argsCheck?.evidence.calls, 2, 'both calls are recorded even when only one matches');
    // A wrong-arguments expectation fails with a precise reason and observed values.
    const wrong = await fx.runEval('agent', [
      caseDoc('wrong', {
        mcp,
        checks: [
          { id: 'args', kind: 'tool_call', server: 'search', tool: 'lookup', called: true, with_arguments: { q: 'nope' } },
          { id: 'absent', kind: 'tool_call', server: 'search', tool: 'lookup', called: false },
        ],
      }),
    ]);
    const wrongResult = await firstResult(wrong);
    assert.deepEqual(
      wrongResult.checks.map((item) => [item.reason, item.passed]),
      [
        ['arguments_mismatch', false],
        ['tool_unexpectedly_called', false],
      ],
    );
  } finally {
    await fx.cleanup();
  }
});

test('mcp contract validation rejects malformed declarations', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    const withMcp = (mcp: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => {
      const check = { id: 'c', kind: 'tool_call', server: 'a', tool: 't', called: true };
      return suiteDoc('software', [caseDoc('x', { checks: [check], mcp: mcp as unknown[], ...extra })]);
    };
    const variants: [unknown, RegExp][] = [
      [withMcp([]), /1\.\.32|mcp/],
      [withMcp([{ name: 'a', tools: [] }]), /1\.\.32/],
      [withMcp([{ name: 'a', tools: [{ name: 't' }] }, { name: 'a', tools: [{ name: 'u' }] }]), /unique/],
      [withMcp([{ name: 'a', tools: [{ name: 't' }, { name: 't' }] }]), /unique/],
      [withMcp([{ name: 'a', tools: [{ name: 'bad name' }] }]), /identifier/],
      [
        suiteDoc('software', [
          caseDoc('x', { checks: [{ id: 'c', kind: 'tool_call', server: 'undeclared', tool: 't', called: true }] }),
        ]),
        /undeclared/,
      ],
      [
        suiteDoc('software', [caseDoc('x', { checks: [{ id: 'c', kind: 'tool_call', server: 'a', called: true }] })]),
        /tool name/,
      ],
    ];
    for (const [value, message] of variants) {
      await assert.rejects(loadSuite(await write(fx.root, 'bad-mcp.json', value)), message);
    }
  } finally {
    await fx.cleanup();
  }
});

test('script checks accept an explicit interpreter for any language', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // An extension-less grading script: the default mapping has no entry for it
    // (it would be executed directly), so passing the interpreter explicitly is
    // the only way it runs under Node.
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync('check.mjs', 'process.exit(0);');
writeFileSync('graded-script', 'process.exit(0);');
`);
    const viaNode = { id: 'grade', kind: 'script', path: 'graded-script', interpreter: [NODE_BINARY] };
    const run = await fx.runEval('software', [caseDoc('graded', { checks: [viaNode] })]);
    const result = await firstCheck(run);
    assert.deepEqual([result.passed, result.reason], [true, 'ok']);
    const bad = { id: 'grade', kind: 'script', path: 'check.mjs', interpreter: [] as unknown as string[] };
    await assert.rejects(
      loadSuite(await write(fx.root, 'bad-interp.json', suiteDoc('software', [caseDoc('a', { checks: [bad] })]))),
      /interpreter/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('server-mode cases start a service, drive it, and terminate it', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // The service and the driver run the same script; CRAFT_EVAL_ROLE splits
    // them. The service creates a ready file and idles; the driver waits for it,
    // probes, prints a verdict and exits.
    await fx.project(`import { writeFileSync, existsSync, readFileSync } from 'node:fs';
if (process.env.EVAL_ROLE === 'service') {
  writeFileSync('service.ready', 'up');
  writeFileSync('service.log', 'serving');
  setInterval(() => {}, 10_000);
} else {
  const deadline = Date.now() + 5000;
  while (!existsSync('service.ready') && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
  }
  const up = existsSync('service.ready');
  const content = up ? readFileSync('service.log', 'utf8') : '';
  console.log('SERVICE_UP=' + up + ' CONTENT=' + content);
  process.exit(up && content === 'serving' ? 0 : 1);
}
`);
    const checks = [
      { id: 'exit', kind: 'exit_code', equals: 0 },
      { id: 'up', kind: 'stdout_contains', value: 'SERVICE_UP=true' },
      { id: 'content', kind: 'stdout_contains', value: 'CONTENT=serving' },
      { id: 'no-junk', kind: 'stdout_not_contains', value: 'SERVICE_UP=false' },
    ];
    const suite = suiteDoc('software', [
      {
        ...caseDoc('probe', { checks }),
        // The driver may wait up to 5s for service readiness; the case budget
        // must cover that wait plus the service startup.
        timeout_s: 10,
        argv: [NODE_BINARY, 'host.mjs'],
        // driver.env is layered onto the service process only, which is how the
        // shared script knows to act as the service rather than the driver.
        driver: { argv: [NODE_BINARY, 'host.mjs'], env: { EVAL_ROLE: 'service' } },
      },
    ]);
    const suitePath = await write(fx.root, 'server-suite.json', suite);
    const subjectPath = await write(fx.root, 'subject.json', { kind: 'software', id: 'svc', version: 'v1' });
    const run = await runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output);
    const result = await firstResult(run);
    assert.equal(result.verdict, 'passed', JSON.stringify(result.checks));
    assert.equal((await reportRun(run)).passed, 1);
  } finally {
    await fx.cleanup();
  }
});

test('stdout assertions work for a bare-print adapter', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`console.log('EVAL_OK alpha=1');
`);
    const checks = [
      { id: 'has', kind: 'stdout_contains', value: 'EVAL_OK' },
      { id: 'not', kind: 'stdout_not_contains', value: 'EVAL_FAIL' },
    ];
    const run = await fx.runEval('software', [caseDoc('print', { checks })]);
    const result = await firstResult(run);
    assert.deepEqual(result.checks.map((item) => item.passed), [true, true]);
    const missing = await fx.runEval('software', [
      caseDoc('print', { checks: [{ id: 'has', kind: 'stdout_contains', value: 'ABSENT' }] }),
    ]);
    const check = await firstCheck(missing);
    assert.deepEqual([check.passed, check.reason], [false, 'stdout_missing']);
  } finally {
    await fx.cleanup();
  }
});

test('per-case workspace isolates state and in_place skips the copy', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // Two cases, each with its own seeded workspace, plus one in-place case.
    await mkdir(join(fx.workspace, 'ws-a'), { recursive: true });
    await mkdir(join(fx.workspace, 'ws-b'), { recursive: true });
    await writeFile(join(fx.workspace, 'ws-a', 'seed.txt'), 'from-a');
    await writeFile(join(fx.workspace, 'ws-b', 'seed.txt'), 'from-b');
    await writeFile(
      join(fx.workspace, 'ws-a', 'host.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';
const seed = readFileSync('seed.txt', 'utf8');
writeFileSync('outputs/seen.json', JSON.stringify({ seed }));
`,
    );
    await writeFile(
      join(fx.workspace, 'ws-b', 'host.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';
const seed = readFileSync('seed.txt', 'utf8');
writeFileSync('outputs/seen.json', JSON.stringify({ seed }));
`,
    );
    const cases = [
      caseDoc('a', {
        workspace: 'ws-a',
        checks: [{ id: 'seed', kind: 'json_equals', path: 'outputs/seen.json', key: 'seed', equals: 'from-a' }],
      }),
      caseDoc('b', {
        workspace: 'ws-b',
        checks: [{ id: 'seed', kind: 'json_equals', path: 'outputs/seen.json', key: 'seed', equals: 'from-b' }],
      }),
    ];
    const run = await fx.runEval('software', cases);
    const report = await reportRun(run);
    assert.deepEqual([report.passed, report.failed], [2, 0]);

    // A workspace that escapes --workspace must be rejected, not resolved.
    await assert.rejects(
      fx.runEval('software', [caseDoc('escape', { workspace: '../outside' })]),
      /leaves --workspace/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('in_place cases run in the subject and never write outputs into it', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // The marker file exists only in the source workspace; a copy would carry it
    // too, so the observable difference is that outputs must not land there.
    await writeFile(join(fx.workspace, 'marker.txt'), 'source');
    await fx.project(`import { readFileSync, writeFileSync } from 'node:fs';
const marker = readFileSync('marker.txt', 'utf8');
writeFileSync(process.env.CRAFT_EVAL_OUTPUT_DIR + '/ran.json', JSON.stringify({ marker }));
`);
    const run = await fx.runEval('software', [
      caseDoc('in-place', {
        in_place: true,
        checks: [
          { id: 'exit', kind: 'exit_code', equals: 0 },
          { id: 'ran', kind: 'json_equals', path: 'outputs/ran.json', key: 'marker', equals: 'source' },
        ],
      }),
    ]);
    const result = await firstResult(run);
    assert.equal(result.verdict, 'passed', JSON.stringify(result.checks));
    // The subject checkout must not gain an outputs directory.
    assert.equal(existsSync(join(fx.workspace, 'outputs')), false);
  } finally {
    await fx.cleanup();
  }
});

test('comparison over many cases reports real metrics, not a restated exit code', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    // Twenty independent cases; the candidate fixes exactly two of them. This
    // exercises the Comparison layer at the scale a real suite has, and pins the
    // metric shape (pair counts, direction, duration observations) rather than
    // just "some numbers came back".
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
const id = process.env.CRAFT_EVAL_CASE_ID;
const fixed = process.env.FIXED === '1';
const target = ['case-03', 'case-17'].includes(id);
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: target ? fixed : true }));
process.exit(target && !fixed ? 1 : 0);
`);
    const cases = Array.from({ length: 20 }, (_, index) =>
      caseDoc(`case-${String(index + 1).padStart(2, '0')}`, {
        checks: [{ id: 'ok', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }],
      }),
    );
    const baseline = await fx.runEval('software', cases, { FIXED: '0' });
    const candidate = await fx.runEval('software', cases, { FIXED: '1' });
    const comparison = await compareRuns(baseline, candidate);

    assert.equal(comparison.status, 'comparable');
    assert.equal(comparison.expected_pairs, 20);
    assert.equal(comparison.measured_pairs, 20);
    assert.equal(comparison.unmeasured_pairs, 0);
    // The candidate is strictly better: two wins, no losses.
    assert.deepEqual([comparison.candidate_wins, comparison.baseline_wins, comparison.ties], [2, 0, 18]);
    // Two wins out of twenty pairs gives p = 0.25: correct, and deliberately not
    // significant. This is why the project requires 20+ positives before a gain
    // claim — the test pins that small samples cannot reach the threshold.
    assert.equal(comparison.one_sided_p, 0.25);
    assert.ok((comparison.one_sided_p ?? 1) > 0.05);
    assert.equal(comparison.independent_task_runs, true);
    // Duration is measured per case, not invented.
    assert.equal(comparison.duration_ms.baseline.observed, 20);
    assert.equal(comparison.duration_ms.candidate.observed, 20);
    assert.ok((comparison.duration_ms.baseline.mean ?? 0) > 0);
    // Software subjects report no cost, which must stay null rather than zero.
    assert.equal(comparison.cost_units.baseline.mean, null);
    // No skill is involved, so no gain claim may be made.
    assert.equal(comparison.skill_gain_supported, false);
  } finally {
    await fx.cleanup();
  }
});


test('runtime controls bound output, cancel adapters and publish progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-controls-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const subject = await write(root, 'subject.json', { kind: 'software', id: 'controls', version: '1' });
    const runtimePath = await write(root, 'runtime.json', runtime());
    const makeSuite = (code: string) => write(root, 'suite.json', suiteDoc('software', [{ id: 'one', argv: [NODE_BINARY, '-e', code], timeout_s: 5, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }]));
    const suite = await makeSuite("process.stdout.write('x'.repeat(10000))");
    const progress: string[] = [];
    const run = await runSuite(suite, subject, runtimePath, workspace, join(root, 'runs'), { max_output_bytes: 128, on_progress: event => { progress.push(event.case_id); } });
    assert.equal((await firstResult(run)).issue, 'output_limit');
    assert.deepEqual(progress, ['one']);
    await assert.rejects(runSuite(suite, subject, runtimePath, workspace, join(root, 'runs'), { max_output_bytes: 0 }), /max_output_bytes/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runSuite(suite, subject, runtimePath, workspace, join(root, 'runs'), { signal: aborted.signal }), /abort/i);
    await makeSuite('setInterval(() => {}, 1000)');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const cancelled = await runSuite(suite, subject, runtimePath, workspace, join(root, 'runs'), { signal: controller.signal });
      assert.equal((await firstResult(cancelled)).issue, 'cancelled');
      assert.notEqual((await firstResult(cancelled)).verdict, 'passed');
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('CLI executes through an installed bin symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-bin-'));
  try {
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const bin = join(root, 'craft-eval');
    await symlink(cli, bin);
    const suite = await write(root, 'suite.json', suiteDoc('software', [{ id: 'one', argv: [NODE_BINARY, '-e', 'process.exit(0)'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }]));
    const result = spawnSync(NODE_BINARY, [bin, 'validate', suite], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'valid');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('execution reports pin copied source bytes instead of trusting Subject version labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-source-pin-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'source.bin'), Buffer.from([0, 255, 1]));
    const suite = await write(root, 'suite.json', suiteDoc('software', [{ id: 'one', argv: [NODE_BINARY, '-e', 'process.exit(0)'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }]));
    const subject = await write(root, 'subject.json', { kind: 'software', id: 'fixed', version: '1' });
    const runtimePath = await write(root, 'runtime.json', runtime());
    const first = await firstResult(await runSuite(suite, subject, runtimePath, workspace, join(root, 'runs')));
    assert.equal(first.workspace_snapshot?.files, 1); assert.equal(first.workspace_snapshot?.bytes, 3);
    await writeFile(join(workspace, 'source.bin'), Buffer.from([0, 255, 2]));
    const second = await firstResult(await runSuite(suite, subject, runtimePath, workspace, join(root, 'runs')));
    assert.notEqual(first.workspace_snapshot?.digest, second.workspace_snapshot?.digest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
