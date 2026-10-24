import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { compareRuns, digest, loadSuite, reportRun, runSuite, signProbability } from '../src/evaluation.js';
import { main } from '../src/cli.js';

const CLI = new URL('../src/cli.js', import.meta.url).href;
const RUNTIME_KEYS = ['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'];

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

function caseDoc(id: string, options: CaseOptions = {}): Record<string, unknown> {
  return {
    id,
    argv: [NODE_BINARY, 'host.mjs'],
    timeout_s: 3,
    checks: options.checks ?? [{ id: 'exit', kind: 'exit_code', equals: 0 }],
    safety_checks: options.safety ?? [],
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'checks' && key !== 'safety')),
  };
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

/** Windows often forbids symlink creation without Developer Mode or admin rights. */
async function canSymlink(root: string): Promise<boolean> {
  const target = join(root, '.symlink-probe-target');
  const link = join(root, '.symlink-probe-link');
  try {
    await writeFile(target, 'x');
    await symlink(target, link);
    await unlink(link);
    await unlink(target);
    return true;
  } catch {
    return false;
  }
}

test('software executes in copy and reports observed failures', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
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
    assert.equal((report.results as any[])[0].safety_verdict, 'passed');
    assert.ok((report.results as any[])[0].stdout_sha256);
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
    const result = (await reportRun(run)).results[0] as any;
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
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'host', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'started' }) + '\\n');
`);
    const run = await fx.runEval('skill', [
      caseDoc('adjacent', { checks: [], should_trigger: false, skill_id: 'answer-skill' }),
    ]);
    const result = (await reportRun(run)).results[0] as any;
    assert.deepEqual([result.verdict, result.trigger.verdict], ['inconclusive', 'inconclusive']);
  } finally {
    await fx.cleanup();
  }
});

test('agent requires completed host trace even for file checks', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ done: true }));
`);
    const checks = [{ id: 'result', kind: 'json_equals', path: 'outputs/result.json', key: 'done', equals: true }];
    const run = await fx.runEval('agent', [caseDoc('agent', { checks })]);
    const result = (await reportRun(run)).results[0] as any;
    assert.deepEqual([result.task_verdict, result.verdict, result.trace_complete], ['passed', 'inconclusive', false]);
  } finally {
    await fx.cleanup();
  }
});

test('skill paired gain requires positive negative and real distinct runs', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync } from 'node:fs';
const enabled = process.env.SKILL_ENABLED === '1';
const positive = process.env.CRAFT_EVAL_CASE_ID.startsWith('task-');
mkdirSync('outputs', { recursive: true });
writeFileSync('outputs/result.json', JSON.stringify({ ok: positive ? enabled : true }));
const id = process.env.CRAFT_EVAL_TASK_RUN_ID;
const events = [];
if (enabled && positive) {
  events.push({ source: 'host', task_run_id: id, event: 'skill.invoked', skill_id: 'answer-skill' });
}
events.push({ source: 'host', task_run_id: id, event: 'run.finished', cost_units: 1 });
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
`);
    const checks = [{ id: 'outcome', kind: 'json_equals', path: 'outputs/result.json', key: 'ok', equals: true }];
    const cases = [] as unknown[];
    for (let index = 0; index < 20; index += 1) {
      cases.push(caseDoc(`task-${index}`, { checks, should_trigger: true, skill_id: 'answer-skill' }));
    }
    cases.push(caseDoc('adjacent', { checks: [], should_trigger: false, skill_id: 'answer-skill' }));
    const baseline = await fx.runEval('skill', cases, { SKILL_ENABLED: '0' });
    const candidate = await fx.runEval('skill', cases, { SKILL_ENABLED: '1' });
    const compared = await compareRuns(baseline, candidate);
    assert.deepEqual(
      [compared.measured_pairs, compared.candidate_wins, compared.candidate_trigger_failures],
      [20, 20, 0],
    );
    assert.equal(compared.skill_gain_supported, true);
    assert.ok((compared.one_sided_p as number) < 0.05);
    assert.equal(compared.independent_task_runs, true);
    await captureStdout(async () => assert.equal(await main(['compare', baseline, candidate]), 0));
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
    const result = (await reportRun(run)).results[0] as any;
    assert.deepEqual([result.issue, result.verdict], ['timeout', 'inconclusive']);
    await fx.project(`import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, JSON.stringify({ source: 'agent', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID, event: 'run.finished' }) + '\\n');
`);
    const second = await fx.runEval('skill', [
      caseDoc('negative', { checks: [], should_trigger: false, skill_id: 'answer-skill' }),
    ]);
    assert.equal(((await reportRun(second)).results[0] as any).trigger.verdict, 'inconclusive');
  } finally {
    await fx.cleanup();
  }
});

test('artifact symlinks cannot read outside workspace', async (t) => {
  const fx = new Fixture();
  await fx.setup();
  try {
    if (!(await canSymlink(fx.root))) {
      // Creating symlinks needs Developer Mode or admin rights on Windows.
      t.skip('symlinks are unavailable to this platform account');
      return;
    }
    const outside = join(fx.root, 'secret.json');
    await writeFile(outside, '{"safe":true}', 'utf8');
    await fx.project(`import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('outputs', { recursive: true });
symlinkSync(process.env.OUTSIDE_FILE, 'outputs/leak.json');
`);
    const checks = [{ id: 'leak', kind: 'json_equals', path: 'outputs/leak.json', key: 'safe', equals: true }];
    const run = await fx.runEval('software', [caseDoc('leak', { checks })], { OUTSIDE_FILE: outside });
    const result = (await reportRun(run)).results[0] as any;
    assert.deepEqual([result.task_verdict, result.checks[0].passed], ['failed', false]);
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
      [{ ...base, cases: [caseDoc('a', { checks: 'bad' as unknown as unknown[] })] }, /array/],
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
      [suiteDoc('skill', [caseDoc('a')]), /should_trigger/],
      [suiteDoc('skill', [caseDoc('a', { checks: [], should_trigger: true, skill_id: 'x' })]), /positive/],
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
    const subjectPath = await write(fx.root, 'subject.json', valid);
    for (const trials of [0, true, 21]) {
      await assert.rejects(runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output, { trials: trials as number }), /trials/);
    }
    await assert.rejects(
      runSuite(suitePath, subjectPath, fx.runtimePath, join(fx.root, 'missing'), fx.output),
      /workspace/,
    );
    if (await canSymlink(fx.root)) {
      await symlink(fx.root, join(fx.workspace, 'linked'), 'dir');
      await assert.rejects(runSuite(suitePath, subjectPath, fx.runtimePath, fx.workspace, fx.output), /symlinks/);
    }
    const failed = await captureStderr(async () => main(['validate', join(fx.root, 'missing.json')]));
    assert.equal(failed.value, 2);
  } finally {
    await fx.cleanup();
  }
});

test('artifact and trace failure modes', async () => {
  const fx = new Fixture();
  await fx.setup();
  try {
    await fx.project(`import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('outputs/folder', { recursive: true });
writeFileSync('outputs/folder/result.json', '{bad json');
try { symlinkSync('/tmp', 'outputs/folder/linked.json'); } catch {}
`);
    const checks = [
      { id: 'missing', kind: 'file_exists', path: 'outputs/missing' },
      { id: 'bad', kind: 'json_equals', path: 'outputs/folder/result.json', key: 'x', equals: true },
      { id: 'linked', kind: 'file_exists', path: 'outputs/folder/linked.json' },
      { id: 'no-trace', kind: 'trace_event', event: 'tool.called', present: false },
    ];
    const run = await fx.runEval('software', [caseDoc('bad', { checks })]);
    const result = (await reportRun(run)).results[0] as any;
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

void CLI;
void readdir;
void stat;
void digest;
void pathToFileURL;
