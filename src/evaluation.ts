/**
 * Run trusted local adapters and judge their observed effects.
 *
 * Only the adapter command executes work. This module never runs a shell, model
 * judge, or promotion action. Cases and reports are JSON so other layers can use
 * the same contract without depending on Craft's storage or runtime.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SCHEMA = 'craft-eval.eval.v1';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_KEYS = ['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'] as const;
const MAX_TRACE_BYTES = 1_000_000;
const MAX_JSON_BYTES = 1_000_000;

export interface Check {
  id: string;
  kind: 'exit_code' | 'file_exists' | 'json_equals' | 'trace_event';
  [key: string]: unknown;
}

export interface Case {
  id: string;
  argv: string[];
  timeout_s?: number;
  checks?: Check[];
  safety_checks?: Check[];
  should_trigger?: boolean;
  skill_id?: string;
  [key: string]: unknown;
}

export interface Suite {
  schema: string;
  suite_id: string;
  subject_kind: string;
  partition: 'development' | 'held_out';
  sanitized: boolean;
  approved_by?: string;
  cases: Case[];
  [key: string]: unknown;
}

export interface Subject {
  kind: string;
  id: string;
  version: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export type Runtime = Record<(typeof RUNTIME_KEYS)[number], string>;

export type Verdict = 'passed' | 'failed' | 'inconclusive' | 'invalid' | 'missing';

export interface CheckResult {
  id: string;
  passed: boolean | null;
  evidence: { kind: string; [key: string]: unknown };
}

export interface TriggerResult {
  expected: boolean;
  used: boolean | null;
  verdict: 'passed' | 'failed' | 'inconclusive';
}

export interface CaseResult {
  case_id: string;
  trial: number;
  task_run_id: string | null;
  verdict: Verdict;
  task_verdict: string;
  safety_verdict: string | null;
  trigger: TriggerResult | null;
  issue: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  cost_units: number | null;
  checks: CheckResult[];
  safety_checks: CheckResult[];
  stdout_sha256: string | null;
  stderr_sha256: string | null;
  trace_sha256: string | null;
  trace_complete: boolean;
}

interface TraceEvent {
  source?: unknown;
  task_run_id?: unknown;
  event?: unknown;
  skill_id?: unknown;
  cost_units?: unknown;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortDeep(value)), 'utf8');
}

/** JSON.stringify with sorted object keys, matching Python's sort_keys=True. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      sorted[key] = sortDeep(object[key]);
    }
    return sorted;
  }
  return value;
}

export function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(jsonBytes(value)).digest('hex');
}

async function load(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8');
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`${name} must be a safe non-empty identifier`);
  }
  return value;
}

function relativePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || isAbsolute(value)) {
    throw new Error(`${name} must be a relative path without '..'`);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.includes('..')) {
    throw new Error(`${name} must be a relative path without '..'`);
  }
  return value;
}

function isPlainInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function checkList(value: unknown, name: string): Check[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  const result: Check[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name} entries must be objects`);
    }
    const check = { ...(item as Check) };
    identifier(check.id, 'check.id');
    const kind = check.kind;
    if (kind === 'exit_code') {
      if (!isPlainInteger(check.equals)) {
        throw new Error('exit_code check requires integer equals');
      }
    } else if (kind === 'file_exists') {
      relativePath(check.path, 'file_exists.path');
    } else if (kind === 'json_equals') {
      relativePath(check.path, 'json_equals.path');
      if (typeof check.key !== 'string' || check.key === '') {
        throw new Error('json_equals requires a key');
      }
      if (!('equals' in check)) {
        throw new Error('json_equals requires equals');
      }
    } else if (kind === 'trace_event') {
      identifier(check.event, 'trace_event.event');
      if (typeof check.present !== 'boolean') {
        throw new Error('trace_event requires boolean present');
      }
    } else {
      throw new Error(`unsupported check kind: ${String(kind)}`);
    }
    result.push(check);
  }
  const ids = result.map((item) => item.id);
  if (ids.length !== new Set(ids).size) {
    throw new Error(`${name} check IDs must be unique`);
  }
  return result;
}

export async function loadSuite(path: string): Promise<Suite> {
  const suite = await load(path);
  if (suite.schema !== SCHEMA) {
    throw new Error(`suite.schema must be ${SCHEMA}`);
  }
  identifier(suite.suite_id, 'suite_id');
  identifier(suite.subject_kind, 'subject_kind');
  if (suite.partition !== 'development' && suite.partition !== 'held_out') {
    throw new Error('partition must be development or held_out');
  }
  if (suite.sanitized !== true) {
    throw new Error('suite must be sanitized');
  }
  if (suite.partition === 'held_out') {
    identifier(suite.approved_by, 'approved_by');
  }
  const cases = suite.cases;
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 1_000) {
    throw new Error('suite needs 1..1000 cases');
  }
  const seen = new Set<string>();
  for (const raw of cases) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('case must be an object');
    }
    const item = raw as Case;
    const caseId = identifier(item.id, 'case.id');
    if (seen.has(caseId)) {
      throw new Error('case IDs must be unique');
    }
    seen.add(caseId);
    const argv = item.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg === '')) {
      throw new Error(`case ${caseId} needs non-empty argv strings`);
    }
    const timeout = item.timeout_s ?? 30;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 3_600) {
      throw new Error(`case ${caseId} timeout_s must be within 0..3600`);
    }
    const checks = checkList(item.checks ?? [], 'checks');
    const safety = checkList(item.safety_checks ?? [], 'safety_checks');
    const taskIds = new Set(checks.map((check) => check.id));
    if (safety.some((check) => taskIds.has(check.id))) {
      throw new Error('task and safety check IDs must be distinct');
    }
    if (suite.subject_kind === 'skill') {
      if (typeof item.should_trigger !== 'boolean') {
        throw new Error('Skill case requires should_trigger');
      }
      identifier(item.skill_id, 'skill_id');
      if (item.should_trigger && checks.length === 0) {
        throw new Error('positive Skill case needs task checks');
      }
    } else if (checks.length === 0) {
      throw new Error(`case ${caseId} needs task checks`);
    }
  }
  return suite as unknown as Suite;
}

async function loadSubject(path: string, kind: string): Promise<Subject> {
  const subject = await load(path);
  if (subject.kind !== kind) {
    throw new Error('subject kind differs from suite');
  }
  identifier(subject.id, 'subject.id');
  identifier(subject.version, 'subject.version');
  const env = subject.env ?? {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('subject.env must contain string environment variables');
  }
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (!ENV_KEY.test(key) || typeof value !== 'string') {
      throw new Error('subject.env must contain string environment variables');
    }
  }
  for (const key of Object.keys(env as Record<string, string>)) {
    if (key.startsWith('CRAFT_EVAL_') || key.startsWith('DYLD_') || key.startsWith('LD_')) {
      throw new Error('subject.env cannot override evaluator controls');
    }
  }
  return subject as unknown as Subject;
}

async function loadRuntime(path: string): Promise<Runtime> {
  const value = await load(path);
  const keys = Object.keys(value).sort();
  if (keys.length !== RUNTIME_KEYS.length || keys.some((key, index) => key !== [...RUNTIME_KEYS].sort()[index])) {
    throw new Error('runtime must pin environment, budget, host, model and tools digests');
  }
  for (const key of RUNTIME_KEYS) {
    if (typeof value[key] !== 'string' || value[key] === '') {
      throw new Error('runtime must pin environment, budget, host, model and tools digests');
    }
  }
  return value as Runtime;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID().replace(/-/g, '')}`;
  await writeFile(temporary, Buffer.concat([jsonBytes(value), Buffer.from('\n')]));
  await rename(temporary, path);
}

const IGNORED = new Set(['.git', '.craft_data', '.venv', '__pycache__']);

async function workspaceCopy(source: string, destination: string): Promise<void> {
  const info = await stat(source).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error('workspace must be a directory');
  }
  await assertNoSymlinks(source, source);
  await mkdir(destination, { recursive: true });
  await copyTree(source, destination);
}

async function assertNoSymlinks(root: string, current: string): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('workspace cannot contain symlinks');
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(root, full);
    }
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const info = await lstatOrNull(path);
  if (info === null || info.isSymbolicLink() || !info.isFile() || info.size > maximum) {
    throw new Error(`missing or oversized artifact: ${basename(path)}`);
  }
  return readFile(path);
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/);
  return parts[parts.length - 1] ?? path;
}

async function artifact(sandbox: string, relativeName: string): Promise<string> {
  const target = resolve(sandbox, relativeName);
  const root = resolve(sandbox);
  const inside = target === root || target.startsWith(root + sep);
  if (!inside) {
    throw new Error('artifact path leaves workspace');
  }
  let current = root;
  for (const part of relativeName.split(/[\\/]+/)) {
    if (part === '' || part === '.') {
      continue;
    }
    current = join(current, part);
    const info = await lstatOrNull(current);
    if (info !== null && info.isSymbolicLink()) {
      throw new Error('artifact path crosses a symlink');
    }
  }
  return target;
}

async function trace(path: string, taskRunId: string): Promise<[TraceEvent[], boolean]> {
  try {
    const raw = await readBounded(path, MAX_TRACE_BYTES);
    const events: TraceEvent[] = [];
    for (const line of raw.toString('utf8').split(/\r?\n/)) {
      if (line.trim() === '') {
        continue;
      }
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return [[], false];
      }
      events.push(value as TraceEvent);
    }
    if (events.length === 0) {
      return [[], false];
    }
    if (events.some((event) => event.task_run_id !== taskRunId || event.source !== 'host')) {
      return [[], false];
    }
    return [events, events.some((event) => event.event === 'run.finished')];
  } catch {
    return [[], false];
  }
}

function jsonEquals(value: unknown, expected: unknown): boolean {
  if (typeof expected !== typeof value) {
    return false;
  }
  if (expected === null || typeof expected !== 'object') {
    return value === expected;
  }
  return JSON.stringify(sortDeep(value)) === JSON.stringify(sortDeep(expected));
}

async function check(
  item: Check,
  sandbox: string,
  exitCode: number | null,
  events: TraceEvent[],
  terminalTrace: boolean,
): Promise<CheckResult> {
  const kind = item.kind;
  const evidence: { kind: string; [key: string]: unknown } = { kind };
  let passed: boolean | null = null;
  if (kind === 'exit_code') {
    passed = exitCode === null ? null : exitCode === item.equals;
    evidence.exit_code = exitCode;
  } else if (kind === 'file_exists') {
    try {
      const path = await artifact(sandbox, relativePath(item.path, 'file_exists.path'));
      const info = await stat(path).catch(() => null);
      passed = info !== null && info.isFile();
    } catch {
      passed = false;
    }
    evidence.path = item.path;
  } else if (kind === 'json_equals') {
    try {
      const path = await artifact(sandbox, relativePath(item.path, 'json_equals.path'));
      const raw = await readBounded(path, MAX_JSON_BYTES);
      let value: unknown = JSON.parse(raw.toString('utf8'));
      for (const key of String(item.key).split('.')) {
        if (value === null || typeof value !== 'object' || !(key in (value as Record<string, unknown>))) {
          throw new Error('missing key');
        }
        value = (value as Record<string, unknown>)[key];
      }
      passed = jsonEquals(value, item.equals);
      evidence.artifact_sha256 = createHash('sha256').update(raw).digest('hex');
    } catch {
      passed = false;
    }
    evidence.path = item.path;
  } else {
    const used = events.some((event) => event.event === item.event) === item.present;
    passed = terminalTrace ? used : null;
    evidence.trace_complete = terminalTrace;
  }
  return { id: item.id, passed, evidence };
}

function verdictOf(results: CheckResult[]): string {
  if (results.length === 0) {
    return 'inconclusive';
  }
  if (results.some((item) => item.passed === false)) {
    return 'failed';
  }
  if (results.some((item) => item.passed === null)) {
    return 'inconclusive';
  }
  return 'passed';
}

const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL'];

async function oneCase(
  item: Case,
  subject: Subject,
  workspace: string,
  runId: string,
  trial: number,
): Promise<CaseResult> {
  const taskRunId = randomUUID().replace(/-/g, '');
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-case-'));
  try {
    const sandbox = join(root, 'workspace');
    await workspaceCopy(workspace, sandbox);
    const tracePath = join(root, 'host-trace.jsonl');
    const stdoutPath = join(root, 'stdout');
    const stderrPath = join(root, 'stderr');
    const env: Record<string, string> = {};
    for (const key of ENV_KEEP) {
      if (key in process.env) {
        env[key] = process.env[key] as string;
      }
    }
    Object.assign(env, {
      HOME: root,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      CRAFT_EVAL_RUN_ID: runId,
      CRAFT_EVAL_TASK_RUN_ID: taskRunId,
      CRAFT_EVAL_CASE_ID: item.id,
      CRAFT_EVAL_TRIAL: String(trial),
      CRAFT_EVAL_TRACE_PATH: tracePath,
      CRAFT_EVAL_OUTPUT_DIR: join(sandbox, 'outputs'),
    });
    Object.assign(env, subject.env ?? {});
    await mkdir(join(sandbox, 'outputs'), { recursive: true });
    const started = process.hrtime.bigint();
    let exitCode: number | null = null;
    let issue: string | null = null;
    const outcome = await runAdapter(item, sandbox, env, stdoutPath, stderrPath);
    exitCode = outcome.exitCode;
    issue = outcome.issue;
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const [events, terminalTrace] = await trace(tracePath, taskRunId);
    const taskChecks = await Promise.all(
      (item.checks ?? []).map((entry) => check(entry, sandbox, exitCode, events, terminalTrace)),
    );
    const safetyChecks = await Promise.all(
      (item.safety_checks ?? []).map((entry) => check(entry, sandbox, exitCode, events, terminalTrace)),
    );
    let trigger: TriggerResult | null = null;
    if ('should_trigger' in item) {
      const used = events.some((event) => event.event === 'skill.invoked' && event.skill_id === item.skill_id);
      const matched = terminalTrace ? used === item.should_trigger : null;
      trigger = {
        expected: item.should_trigger as boolean,
        used: terminalTrace ? used : null,
        verdict: matched === null ? 'inconclusive' : matched ? 'passed' : 'failed',
      };
    }
    const taskVerdict = verdictOf(taskChecks);
    const safetyVerdict = verdictOf(safetyChecks);
    let verdict: Verdict = decideVerdict(taskVerdict, safetyVerdict, safetyChecks, trigger, issue);
    if (issue === null && subject.kind === 'agent' && !terminalTrace && verdict === 'passed') {
      verdict = 'inconclusive';
    }
    const cost = readCost(events);
    return {
      case_id: item.id,
      trial,
      task_run_id: taskRunId,
      verdict,
      task_verdict: taskVerdict,
      safety_verdict: safetyChecks.length > 0 ? safetyVerdict : null,
      trigger,
      issue,
      exit_code: exitCode,
      duration_ms: durationMs,
      cost_units: cost,
      checks: taskChecks,
      safety_checks: safetyChecks,
      stdout_sha256: await sha256File(stdoutPath),
      stderr_sha256: await sha256File(stderrPath),
      trace_sha256: await sha256File(tracePath),
      trace_complete: terminalTrace,
    };
  } finally {
    await removeTree(root);
  }
}

function decideVerdict(
  taskVerdict: string,
  safetyVerdict: string,
  safetyChecks: CheckResult[],
  trigger: TriggerResult | null,
  issue: string | null,
): Verdict {
  const triggerVerdict = trigger?.verdict;
  const failed = taskVerdict === 'failed' || safetyVerdict === 'failed' || triggerVerdict === 'failed';
  if (failed) {
    return 'failed';
  }
  const inconclusive =
    Boolean(issue) ||
    (taskVerdict === 'inconclusive' && triggerVerdict !== 'passed') ||
    (safetyVerdict === 'inconclusive' && safetyChecks.length > 0) ||
    triggerVerdict === 'inconclusive';
  if (issue) {
    return issue === 'timeout' ? 'inconclusive' : 'invalid';
  }
  return inconclusive ? 'inconclusive' : 'passed';
}

function readCost(events: TraceEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.event !== 'run.finished') {
      continue;
    }
    const cost = event.cost_units;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      return cost;
    }
  }
  return null;
}

async function sha256File(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path);
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return null;
  }
}

async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

interface AdapterOutcome {
  exitCode: number | null;
  issue: string | null;
}

function runAdapter(
  item: Case,
  sandbox: string,
  env: Record<string, string>,
  stdoutPath: string,
  stderrPath: string,
): Promise<AdapterOutcome> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(item.argv[0] ?? '', item.argv.slice(1), {
        cwd: sandbox,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      done({ exitCode: null, issue: `adapter_error:${(error as Error).name}` });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killTree(child.pid);
      void writeCapture(stdoutPath, stdout, stderrPath, stderr).then(() => done({ exitCode: null, issue: 'timeout' }));
    }, (item.timeout_s ?? 30) * 1_000);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void writeCapture(stdoutPath, stdout, stderrPath, stderr).then(() =>
        done({
          exitCode: null,
          issue: `adapter_error:${error.code === 'ENOENT' ? 'FileNotFoundError' : error.name}`,
        }),
      );
    });
    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void writeCapture(stdoutPath, stdout, stderrPath, stderr).then(() => done({ exitCode: code, issue: null }));
    });
  });
}

async function writeCapture(
  stdoutPath: string,
  stdout: Buffer[],
  stderrPath: string,
  stderr: Buffer[],
): Promise<void> {
  await writeFile(stdoutPath, Buffer.concat(stdout));
  await writeFile(stderrPath, Buffer.concat(stderr));
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The adapter already exited; nothing left to kill.
  }
}

export interface RunOptions {
  trials?: number;
}

export async function runSuite(
  suitePath: string,
  subjectPath: string,
  runtimePath: string,
  workspace: string,
  outputRoot: string,
  options: RunOptions | number = {},
): Promise<string> {
  const trials = typeof options === 'number' ? options : (options.trials ?? 1);
  const suite = await loadSuite(suitePath);
  const subject = await loadSubject(subjectPath, suite.subject_kind);
  const runtime = await loadRuntime(runtimePath);
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) {
    throw new Error('trials must be 1..20');
  }
  const workspacePath = resolve(workspace);
  const workspaceInfo = await stat(workspacePath).catch(() => null);
  if (workspaceInfo === null) {
    throw new Error('workspace must be a directory');
  }
  const output = resolve(outputRoot);
  if (output === workspacePath || output.startsWith(workspacePath + sep)) {
    throw new Error('output must be outside workspace');
  }
  await mkdir(output, { recursive: true });
  const runId = randomUUID().replace(/-/g, '');
  const runDir = join(output, runId);
  await mkdir(join(runDir, 'results'), { recursive: true });
  const plan = {
    schema: SCHEMA,
    run_id: runId,
    suite,
    suite_digest: digest(suite),
    subject: {
      kind: subject.kind,
      id: subject.id,
      version: subject.version,
      digest: digest(subject),
    },
    runtime,
    trials,
    expected: suite.cases.length * trials,
  };
  await atomicJson(join(runDir, 'plan.json'), plan);
  for (const item of suite.cases) {
    for (let trial = 1; trial <= trials; trial += 1) {
      const result = await oneCase(item, subject, workspacePath, runId, trial);
      await atomicJson(join(runDir, 'results', `${item.id}-${trial}.json`), result);
    }
  }
  return runDir;
}

async function loadRun(path: string): Promise<{ plan: Record<string, any>; results: CaseResult[] }> {
  const root = resolve(path);
  const plan = await load(join(root, 'plan.json'));
  if (plan.schema !== SCHEMA || digest(plan.suite) !== plan.suite_digest) {
    throw new Error('run plan is invalid or changed');
  }
  const results: CaseResult[] = [];
  const suite = plan.suite as Suite;
  const trials = Number(plan.trials);
  for (const item of suite.cases) {
    for (let trial = 1; trial <= trials; trial += 1) {
      const resultPath = join(root, 'results', `${item.id}-${trial}.json`);
      const info = await stat(resultPath).catch(() => null);
      if (info !== null && info.isFile()) {
        const result = (await load(resultPath)) as unknown as CaseResult;
        if (result.case_id !== item.id || result.trial !== trial) {
          throw new Error('result does not match run plan');
        }
        results.push(result);
      } else {
        results.push({
          case_id: item.id,
          trial,
          verdict: 'missing',
          task_verdict: 'missing',
          safety_verdict: 'missing',
          task_run_id: null,
          trigger: null,
          duration_ms: null,
          cost_units: null,
        } as CaseResult);
      }
    }
  }
  return { plan, results };
}

export interface RunReport {
  run_id: string;
  suite_id: string;
  subject: Record<string, unknown>;
  partition: string;
  expected: number;
  recorded: number;
  passed: number;
  failed: number;
  inconclusive: number;
  invalid: number;
  missing: number;
  status: 'complete' | 'incomplete';
  results: CaseResult[];
}

export async function reportRun(path: string): Promise<RunReport> {
  const { plan, results } = await loadRun(path);
  const counts: Record<string, number> = {};
  for (const kind of ['passed', 'failed', 'inconclusive', 'invalid', 'missing']) {
    counts[kind] = results.filter((item) => item.verdict === kind).length;
  }
  const missing = counts.missing ?? 0;
  const inconclusive = counts.inconclusive ?? 0;
  const invalid = counts.invalid ?? 0;
  return {
    run_id: plan.run_id,
    suite_id: plan.suite.suite_id,
    subject: plan.subject,
    partition: plan.suite.partition,
    expected: plan.expected,
    recorded: plan.expected - missing,
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    inconclusive,
    invalid,
    missing,
    status: missing === 0 && inconclusive === 0 && invalid === 0 ? 'complete' : 'incomplete',
    results,
  };
}

export function signProbability(wins: number, losses: number): number | null {
  const total = wins + losses;
  if (total === 0) {
    return null;
  }
  let probability = 0;
  for (let successes = wins; successes <= total; successes += 1) {
    probability += Math.exp(
      logGamma(total + 1) - logGamma(successes + 1) - logGamma(total - successes + 1) - total * Math.log(2),
    );
  }
  return Math.min(1, probability);
}

function logGamma(value: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = value;
  const x = value;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const coefficient of cof) {
    y += 1;
    ser += coefficient / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export async function compareRuns(baselinePath: string, candidatePath: string): Promise<Record<string, unknown>> {
  const baseline = await loadRun(baselinePath);
  const candidate = await loadRun(candidatePath);
  const left = baseline.plan;
  const right = candidate.plan;
  if (
    left.suite_digest !== right.suite_digest ||
    JSON.stringify(sortDeep(left.runtime)) !== JSON.stringify(sortDeep(right.runtime)) ||
    left.trials !== right.trials ||
    left.subject.kind !== right.subject.kind
  ) {
    throw new Error('runs are not comparable');
  }
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let unmeasured = 0;
  const casesInOrder: Case[] = [];
  for (const item of left.suite.cases as Case[]) {
    for (let index = 0; index < Number(left.trials); index += 1) {
      casesInOrder.push(item);
    }
  }
  for (let index = 0; index < casesInOrder.length; index += 1) {
    const item = casesInOrder[index];
    const a = baseline.results[index];
    const b = candidate.results[index];
    if (item === undefined || a === undefined || b === undefined) {
      continue;
    }
    if (!item.checks || item.checks.length === 0) {
      continue;
    }
    if (!['passed', 'failed'].includes(a.task_verdict) || !['passed', 'failed'].includes(b.task_verdict)) {
      unmeasured += 1;
    } else if (a.task_verdict === b.task_verdict) {
      ties += 1;
    } else if (b.task_verdict === 'passed') {
      wins += 1;
    } else {
      losses += 1;
    }
  }
  const subjectKind = left.suite.subject_kind as string;
  const positive = (left.suite.cases as Case[]).filter((item) => item.should_trigger === true).length;
  const negative = (left.suite.cases as Case[]).filter((item) => item.should_trigger === false).length;
  const triggerFailures = candidate.results.filter((item) => item.trigger !== null && item.trigger?.verdict !== 'passed').length;
  const safetyFailures = candidate.results.filter((item) => item.safety_verdict === 'failed').length;
  const runIds = [...baseline.results, ...candidate.results].map((item) => item.task_run_id);
  const independent = runIds.every(Boolean) && new Set(runIds).size === runIds.length;
  const probability = signProbability(wins, losses);
  const complete =
    unmeasured === 0 &&
    [...baseline.results, ...candidate.results].every(
      (item) => item.verdict !== 'missing' && item.verdict !== 'inconclusive' && item.verdict !== 'invalid',
    );
  const gain =
    subjectKind === 'skill' &&
    left.suite.partition === 'held_out' &&
    positive >= 20 &&
    negative >= 1 &&
    complete &&
    independent &&
    triggerFailures === 0 &&
    safetyFailures === 0 &&
    left.subject.digest !== right.subject.digest &&
    wins > losses &&
    probability !== null &&
    probability <= 0.05;
  const metric = (items: CaseResult[], name: 'duration_ms' | 'cost_units') => {
    const values = items.map((item) => item[name]).filter((value): value is number => isNumber(value));
    return { observed: values.length, mean: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length };
  };
  return {
    status: complete ? 'comparable' : 'inconclusive',
    subject_kind: subjectKind,
    baseline_run_id: left.run_id,
    candidate_run_id: right.run_id,
    expected_pairs: baseline.results.length,
    measured_pairs: wins + losses + ties,
    unmeasured_pairs: unmeasured,
    candidate_wins: wins,
    baseline_wins: losses,
    ties,
    one_sided_p: probability,
    candidate_trigger_failures: triggerFailures,
    candidate_safety_failures: safetyFailures,
    independent_task_runs: independent,
    skill_gain_supported: gain,
    duration_ms: { baseline: metric(baseline.results, 'duration_ms'), candidate: metric(candidate.results, 'duration_ms') },
    cost_units: { baseline: metric(baseline.results, 'cost_units'), candidate: metric(candidate.results, 'cost_units') },
  };
}
