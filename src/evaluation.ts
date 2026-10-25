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
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'craft-eval.eval.v1';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_KEYS = ['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'] as const;
const MAX_TRACE_BYTES = 1_000_000;
const MAX_JSON_BYTES = 1_000_000;

export interface Check {
  id: string;
  kind: 'exit_code' | 'file_exists' | 'json_equals' | 'trace_event' | 'script' | 'tool_call' | 'stdout_contains' | 'stdout_not_contains';
  [key: string]: unknown;
}

/**
 * A skill case pins the skill it expects to be used. `skill_path` is resolved
 * relative to the workspace, so the evaluator can prove the skill exists and
 * bind its content digest into the run plan instead of trusting a bare id.
 */
export interface SkillBinding {
  skill_id: string;
  skill_path: string;
  should_trigger: boolean;
}

/**
 * A mocked MCP tool the evaluator serves and records. `response` is returned
 * verbatim to the client; `expect_arguments` (when set) is what `tool_call`
 * checks compare against.
 */
export interface MockTool {
  name: string;
  description?: string;
  input_schema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  response?: { content?: Array<{ type: 'text'; text: string }>; is_error?: boolean };
}

/** A mocked MCP server the evaluator starts per case and records all calls of. */
export interface McpServerSpec {
  name: string;
  tools: MockTool[];
}

export interface Case {
  id: string;
  argv: string[];
  timeout_s?: number;
  checks?: Check[];
  safety_checks?: Check[];
  skill?: SkillBinding;
  /** Mocked MCP servers started by the evaluator for this case. */
  mcp?: McpServerSpec[];
  /**
   * Server-mode case: `argv` starts a long-running service and `driver.argv`
   * exercises it to completion. The evaluator terminates the service after the
   * driver exits; trace, checks and stdout/stderr all belong to the driver.
   * `driver.env` is layered over the shared environment for the service process
   * only, so a host script can distinguish its role from the driver's.
   */
  driver?: { argv: string[]; env?: Record<string, string> };
  [key: string]: unknown;
}

export interface Suite {
  schema: string;
  suite_id: string;
  subject_kind: string;
  /** Case-set role. Deliberately not named `stage`: craft has a separate, unrelated notion of stage. */
  partition: Partition;
  sanitized: boolean;
  approved_by?: string;
  cases: Case[];
  [key: string]: unknown;
}

/** Whether a case set may inform delivery claims. */
export type Partition = 'development' | 'held_out';

export interface Subject {
  kind: string;
  id: string;
  version: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export type Runtime = Record<(typeof RUNTIME_KEYS)[number], string>;

export type Verdict = 'passed' | 'failed' | 'inconclusive' | 'invalid' | 'missing';
/** Outcome of one check group; `missing` only appears for an unrecorded case. */
export type CaseVerdict = 'passed' | 'failed' | 'inconclusive' | 'missing';

/**
 * Why a check produced the result it did. Distinguishing these is what lets a
 * consumer tell "the file was absent" from "the file was there but unparseable",
 * which have very different fixes.
 */
export type CheckReason =
  | 'ok'
  | 'not_found'
  | 'invalid_json'
  | 'key_missing'
  | 'type_mismatch'
  | 'value_mismatch'
  | 'not_a_file'
  | 'outside_workspace'
  | 'symlink_rejected'
  | 'oversized'
  | 'no_trace'
  | 'trace_incomplete'
  | 'exit_code_mismatch'
  | 'timer_expired'
  | 'script_failed'
  | 'script_error'
  | 'tool_not_called'
  | 'tool_unexpectedly_called'
  | 'arguments_mismatch'
  | 'tool_errored'
  | 'stdout_missing'
  | 'stdout_present';

export interface CheckResult {
  id: string;
  passed: boolean | null;
  reason: CheckReason;
  evidence: { kind: string; [key: string]: unknown };
}

/**
 * Where the trigger verdict came from.
 *
 * `gateway` means the evaluator itself observed the invocation through a
 * wrapper it installed, so the subject cannot forge it. `self_reported` means
 * the subject wrote the event, which is enough to diagnose but not enough to
 * claim a gain. `unobserved` means no evidence exists at all.
 */
export type TriggerEvidence = 'gateway' | 'self_reported' | 'unobserved';

export interface TriggerResult {
  expected: boolean;
  used: boolean | null;
  evidence: TriggerEvidence;
  /** Digest of the skill definition the case was pinned to, or null when unbound. */
  skill_digest: string | null;
  verdict: 'passed' | 'failed' | 'inconclusive';
}

export interface CaseResult {
  case_id: string;
  trial: number;
  task_run_id: string | null;
  verdict: Verdict;
  task_verdict: CaseVerdict;
  safety_verdict: CaseVerdict | null;
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
    } else if (kind === 'script') {
      relativePath(check.path, 'script.path');
      if (check.args !== undefined) {
        if (!Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string')) {
          throw new Error('script args must be an array of strings');
        }
      }
      if (check.interpreter !== undefined) {
        if (!Array.isArray(check.interpreter) || check.interpreter.length === 0 || check.interpreter.some((arg) => typeof arg !== 'string' || arg === '')) {
          throw new Error('script interpreter must be a non-empty array of strings');
        }
      }
      const passes = check.pass_exit_codes ?? [0];
      if (!Array.isArray(passes) || passes.length === 0 || !passes.every(isPlainInteger)) {
        throw new Error('script pass_exit_codes must be a non-empty array of integers');
      }
    } else if (kind === 'stdout_contains' || kind === 'stdout_not_contains') {
      if (typeof check.value !== 'string' || check.value === '') {
        throw new Error(`${String(kind)} requires a non-empty string value`);
      }
    } else if (kind === 'tool_call') {
      if (typeof check.server !== 'string' || check.server === '') {
        throw new Error('tool_call requires a server name');
      }
      if (typeof check.tool !== 'string' || check.tool === '') {
        throw new Error('tool_call requires a tool name');
      }
      if (typeof check.called !== 'boolean') {
        throw new Error('tool_call requires boolean called');
      }
      if (check.with_arguments !== undefined && typeof check.with_arguments !== 'object') {
        throw new Error('tool_call with_arguments must be an object');
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
    if (item.driver !== undefined) {
      const driverArgv = (item.driver as { argv?: unknown }).argv;
      if (!Array.isArray(driverArgv) || driverArgv.length === 0 || driverArgv.some((arg) => typeof arg !== 'string' || arg === '')) {
        throw new Error(`case ${caseId} driver needs non-empty argv strings`);
      }
      const driverEnv = (item.driver as { env?: unknown }).env;
      if (driverEnv !== undefined) {
        if (driverEnv === null || typeof driverEnv !== 'object' || Array.isArray(driverEnv)) {
          throw new Error(`case ${caseId} driver.env must be an object of strings`);
        }
        for (const [key, value] of Object.entries(driverEnv as Record<string, unknown>)) {
          if (!ENV_KEY.test(key) || typeof value !== 'string') {
            throw new Error(`case ${caseId} driver.env must be an object of strings`);
          }
        }
      }
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
    const mcpServers = item.mcp;
    if (mcpServers !== undefined) {
      if (!Array.isArray(mcpServers) || mcpServers.length > 8) {
        throw new Error(`case ${caseId} mcp must be an array of at most 8 servers`);
      }
      const serverNames = new Set<string>();
      for (const server of mcpServers) {
        if (server === null || typeof server !== 'object' || Array.isArray(server)) {
          throw new Error(`case ${caseId} mcp servers must be objects`);
        }
        const name = identifier(server.name, 'mcp.name');
        if (serverNames.has(name)) {
          throw new Error(`case ${caseId} mcp server names must be unique`);
        }
        serverNames.add(name);
        const tools = server.tools;
        if (!Array.isArray(tools) || tools.length === 0 || tools.length > 32) {
          throw new Error(`case ${caseId} mcp server ${name} needs 1..32 tools`);
        }
        const toolNames = new Set<string>();
        for (const tool of tools) {
          if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
            throw new Error(`case ${caseId} mcp tools must be objects`);
          }
          const toolName = identifier(tool.name, 'mcp.tool.name');
          if (toolNames.has(toolName)) {
            throw new Error(`case ${caseId} mcp tool names must be unique within a server`);
          }
          toolNames.add(toolName);
        }
      }
    }
    for (const entry of [...checks, ...safety]) {
      if (entry.kind === 'tool_call' && !(mcpServers ?? []).some((server) => server.name === entry.server)) {
        throw new Error(`case ${caseId} tool_call references undeclared mcp server: ${String(entry.server)}`);
      }
    }
    if (suite.subject_kind === 'skill') {
      // A skill case must pin the skill it claims to exercise. A bare id is not
      // evidence: the evaluator resolves the path and binds the content digest.
      const skill = item.skill;
      if (skill === null || typeof skill !== 'object' || Array.isArray(skill)) {
        throw new Error('Skill case requires a skill binding');
      }
      identifier(skill.skill_id, 'skill.skill_id');
      relativePath(skill.skill_path, 'skill.skill_path');
      if (typeof skill.should_trigger !== 'boolean') {
        throw new Error('skill.should_trigger must be a boolean');
      }
      if (skill.should_trigger && checks.length === 0) {
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

const IGNORED = new Set([
  '.git',
  '.craft_data',
  '.venv',
  '__pycache__',
  // Build/dependency artifacts across ecosystems; copying them would slow every
  // case and can break tools that resolve symlinked stores.
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  '.next',
  '.turbo',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

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

/** Trace sources the evaluator accepts: its own gateway, or the host it launched. */
const TRACE_SOURCES = new Set(['host', 'gateway']);

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
    if (events.some((event) => event.task_run_id !== taskRunId || !TRACE_SOURCES.has(String(event.source)))) {
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

/**
 * A skill is a directory whose SKILL.md carries YAML frontmatter with `name` and
 * `description`. Resolving it here is what turns `skill_id` from a claim into a
 * verifiable fact bound to a content digest.
 */
export interface ResolvedSkill {
  skill_id: string;
  digest: string;
  name: string;
}

async function resolveSkill(workspace: string, binding: SkillBinding): Promise<ResolvedSkill> {
  const directory = resolve(workspace, binding.skill_path);
  const root = resolve(workspace);
  if (directory !== root && !directory.startsWith(root + sep)) {
    throw new Error(`skill.skill_path leaves workspace: ${binding.skill_path}`);
  }
  const manifestPath = join(directory, 'SKILL.md');
  const info = await stat(manifestPath).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new Error(`skill manifest not found: ${binding.skill_path}/SKILL.md`);
  }
  const text = await readFile(manifestPath, 'utf8');
  const name = frontmatterValue(text, 'name');
  const description = frontmatterValue(text, 'description');
  if (name === null || description === null) {
    throw new Error(`skill manifest needs name and description: ${binding.skill_path}/SKILL.md`);
  }
  if (name !== binding.skill_id) {
    throw new Error(`skill.skill_id "${binding.skill_id}" does not match manifest name "${name}"`);
  }
  return { skill_id: name, digest: digest(text), name };
}

/** Read one top-level scalar from a leading `---` YAML frontmatter block. */
function frontmatterValue(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return null;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '---') {
      return null;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match !== null && match[1] === key) {
      const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
      return value === '' ? null : value;
    }
  }
  return null;
}

interface ScriptOutcome {
  exitCode: number | null;
  issue: string | null;
}

/**
 * Resolve a real Node binary for running grading scripts. `process.execPath`
 * cannot be trusted: when this evaluator itself runs under an Electron wrapper
 * it points at the wrapper application, which would silently exit 0 instead of
 * executing the script.
 */
function nodeBinary(): string {
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
    const candidate = join(directory.replace(/[\\/]+$/, ''), 'node.exe');
    if (existsSync(candidate) && !candidate.includes('DSH Desktop')) {
      return candidate;
    }
  }
  return process.execPath;
}

/** Run a deterministic grading script. Exit 0 means pass; the runner is the same trusted-adapter path. */
async function runScript(
  scriptPath: string,
  args: string[],
  sandbox: string,
  timeoutSeconds: number,
  explicitInterpreter?: string[],
): Promise<ScriptOutcome> {
  const extension = extname(scriptPath).toLowerCase();
  const interpreters: Record<string, string> = {
    '.mjs': nodeBinary(),
    '.js': nodeBinary(),
    '.cjs': nodeBinary(),
    '.py': 'python3',
    '.sh': 'sh',
    '.ps1': 'pwsh',
  };
  const fallback = interpreters[extension];
  const interpreter: string[] = explicitInterpreter ?? (fallback === undefined ? [scriptPath] : [fallback]);
  const argv = [...interpreter, scriptPath, ...args];
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd: sandbox,
        env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? '' },
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      done({ exitCode: null, issue: (error as Error).name });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killTree(child.pid);
      done({ exitCode: null, issue: 'timeout' });
    }, timeoutSeconds * 1_000);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      done({ exitCode: null, issue: error.code ?? error.name });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      done({ exitCode: code, issue: null });
    });
  });
}

/**
 * Decide the trigger verdict from the strongest evidence available.
 *
 * A `gateway` event is produced by a wrapper the evaluator installed, so it is
 * authoritative. Events with `source: "host"` are written by the subject: they
 * are useful for diagnosis but can never support a gain claim, because a subject
 * that reports its own success proves nothing. No terminal trace means we simply
 * cannot judge.
 */
function buildTrigger(
  binding: SkillBinding,
  skill: ResolvedSkill,
  events: TraceEvent[],
  terminalTrace: boolean,
): TriggerResult {
  const skillDigest = skill.digest;
  if (!terminalTrace) {
    return {
      expected: binding.should_trigger,
      used: null,
      evidence: 'unobserved',
      skill_digest: skillDigest,
      verdict: 'inconclusive',
    };
  }
  const matching = (source: string) =>
    events.some(
      (event) => event.event === 'skill.invoked' && event.skill_id === binding.skill_id && event.source === source,
    );
  const gatewayUsed = matching('gateway');
  const selfUsed = matching('host');
  const evidence: TriggerEvidence = gatewayUsed || selfUsed ? (gatewayUsed ? 'gateway' : 'self_reported') : 'gateway';
  const used = gatewayUsed || selfUsed;
  const matched = used === binding.should_trigger;
  return {
    expected: binding.should_trigger,
    used,
    evidence,
    skill_digest: skillDigest,
    verdict: matched ? 'passed' : 'failed',
  };
}

interface RunningMcp {
  configPath: string;
  environment: Record<string, string>;
  stop: () => Promise<void>;
}

/**
 * Start one mock MCP server process per declared server. Each gets its own
 * config file and log; the descriptor env var tells the subject where to connect
 * without the evaluator touching the subject's argv.
 */
async function startMcpServers(specs: McpServerSpec[], root: string, taskRunId: string): Promise<RunningMcp> {
  const mockEntry = fileURLToPath(new URL('./mcp-mock.js', import.meta.url));
  const configPath = join(root, 'mcp-mock-config.json');
  const servers = specs.map((spec) => ({
    name: spec.name,
    log_path: join(root, `mcp-calls-${spec.name}.jsonl`),
    tools: spec.tools,
  }));
  await writeFile(
    configPath,
    JSON.stringify({ servers } satisfies { servers: Array<{ name: string; log_path: string; tools: MockTool[] }> }),
  );
  const environment: Record<string, string> = {
    CRAFT_EVAL_MCP: JSON.stringify(
      servers.map((server) => ({
        name: server.name,
        command: nodeBinary(),
        args: [mockEntry, '--server', server.name, '--config', configPath],
      })),
    ),
  };
  // The mock servers are launched lazily by the subject through the descriptor,
  // so there is nothing to spawn here; the lifetime guard lives in mcp-mock.ts.
  const stop = async (): Promise<void> => {
    // Nothing to terminate: servers self-terminate via the lifetime guard once
    // the client disconnects or the guard fires.
    await Promise.resolve();
  };
  void taskRunId;
  return { configPath, environment, stop };
}

interface McpCallRecord {
  server: string;
  tool: string;
  arguments: unknown;
  delivered: boolean;
}

async function readMcpCalls(configPath: string): Promise<McpCallRecord[]> {
  const config = (await load(configPath)) as unknown as { servers: Array<{ name: string; log_path: string }> };
  const calls: McpCallRecord[] = [];
  for (const server of config.servers) {
    try {
      const raw = await readFile(server.log_path, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') {
          continue;
        }
        try {
          const value = JSON.parse(line) as McpCallRecord;
          if (value.server === server.name && typeof value.tool === 'string') {
            calls.push(value);
          }
        } catch {
          // A torn line means the process died mid-write; keep what parsed.
        }
      }
    } catch {
      // No log file means no calls reached this server.
    }
  }
  return calls;
}

/** Start a long-running service process; returns its terminator. */
function startService(item: Case, sandbox: string, env: Record<string, string>): Promise<() => Promise<void>> {
  return new Promise((resolveStarted) => {
    let child: ChildProcess;
    try {
      child = spawn(item.argv[0] ?? '', item.argv.slice(1), {
        cwd: sandbox,
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      // A service that cannot start still yields a terminator; the driver will
      // fail against a dead endpoint and the case verdicts reflect that.
      resolveStarted(async () => {});
      return;
    }
    child.on('error', () => {
      // Swallow: the driver outcome is the verdict, not the service's.
    });
    resolveStarted(async () => {
      killTree(child.pid);
      // Give the process a moment to die so the temp tree can be removed.
      await new Promise((done) => setTimeout(done, 120));
    });
  });
}

async function check(
  item: Check,
  sandbox: string,
  exitCode: number | null,
  events: TraceEvent[],
  terminalTrace: boolean,
  timeoutSeconds: number,
  mcpCalls: McpCallRecord[],
  capturedStdout: Buffer,
): Promise<CheckResult> {
  const kind = item.kind;
  const evidence: { kind: string; [key: string]: unknown } = { kind };
  let passed: boolean | null = null;
  let reason: CheckReason = 'ok';
  if (kind === 'exit_code') {
    passed = exitCode === null ? null : exitCode === item.equals;
    evidence.exit_code = exitCode;
    if (passed === false) {
      reason = 'exit_code_mismatch';
    } else if (passed === null) {
      reason = 'timer_expired';
    }
  } else if (kind === 'file_exists') {
    try {
      const path = await artifact(sandbox, relativePath(item.path, 'file_exists.path'));
      const info = await stat(path).catch(() => null);
      passed = info !== null && info.isFile();
      reason = passed ? 'ok' : info === null ? 'not_found' : 'not_a_file';
    } catch (error) {
      passed = false;
      reason = classifyArtifactError(error);
    }
    evidence.path = item.path;
  } else if (kind === 'json_equals') {
    try {
      const path = await artifact(sandbox, relativePath(item.path, 'json_equals.path'));
      const raw = await readBounded(path, MAX_JSON_BYTES);
      let value: unknown = JSON.parse(raw.toString('utf8'));
      for (const key of String(item.key).split('.')) {
        if (value === null || typeof value !== 'object' || !(key in (value as Record<string, unknown>))) {
          passed = false;
          reason = 'key_missing';
          evidence.path = item.path;
          return { id: item.id, passed, reason, evidence };
        }
        value = (value as Record<string, unknown>)[key];
      }
      passed = jsonEquals(value, item.equals);
      reason = passed ? 'ok' : typeof value === typeof item.equals ? 'value_mismatch' : 'type_mismatch';
      evidence.artifact_sha256 = createHash('sha256').update(raw).digest('hex');
    } catch (error) {
      passed = false;
      reason = error instanceof SyntaxError ? 'invalid_json' : classifyArtifactError(error);
    }
    evidence.path = item.path;
  } else if (kind === 'script') {
    const scriptPath = await artifact(sandbox, relativePath(item.path, 'script.path')).catch(() => null);
    const scriptInfo = scriptPath === null ? null : await stat(scriptPath).catch(() => null);
    if (scriptPath === null || scriptInfo === null || !scriptInfo.isFile()) {
      passed = false;
      reason = 'not_found';
    } else {
      const outcome = await runScript(
      scriptPath,
      Array.isArray(item.args) ? (item.args as string[]) : [],
      sandbox,
      Math.max(1, Math.floor(timeoutSeconds)),
      Array.isArray(item.interpreter) ? (item.interpreter as string[]) : undefined,
    );
      evidence.exit_code = outcome.exitCode;
      if (outcome.issue !== null) {
        passed = false;
        reason = 'script_error';
        evidence.issue = outcome.issue;
      } else {
        const accepted = (item.pass_exit_codes ?? [0]) as number[];
        passed = outcome.exitCode !== null && accepted.includes(outcome.exitCode);
        reason = passed ? 'ok' : 'script_failed';
      }
    }
    evidence.path = item.path;
  } else if (kind === 'stdout_contains' || kind === 'stdout_not_contains') {
    // Judged from the in-memory capture; the raw text is still never persisted,
    // keeping the privacy boundary while making "print-and-assert" possible in
    // any language the adapter can be written in.
    const text = capturedStdout.toString('utf8');
    const contains = text.includes(String(item.value));
    passed = kind === 'stdout_contains' ? contains : !contains;
    reason = passed ? 'ok' : kind === 'stdout_contains' ? 'stdout_missing' : 'stdout_present';
    evidence.length = text.length;
    evidence.value = item.value;
  } else if (kind === 'tool_call') {
    // Evidence comes from the evaluator-side mock server log, never from the
    // subject's own trace, so a subject cannot claim a tool call it never made.
    const relevant = mcpCalls.filter((call) => call.server === item.server && call.tool === item.tool);
    const called = relevant.length > 0;
    evidence.calls = relevant.length;
    evidence.server = item.server;
    evidence.tool = item.tool;
    if (item.called === true) {
      if (!called) {
        passed = false;
        reason = 'tool_not_called';
      } else if (item.with_arguments !== undefined) {
        const matchingArgs = relevant.some((call) => jsonEquals(call.arguments, item.with_arguments));
        passed = matchingArgs;
        reason = matchingArgs ? 'ok' : 'arguments_mismatch';
        evidence.expected_arguments = item.with_arguments;
        evidence.observed_arguments = relevant.map((call) => call.arguments);
      } else {
        passed = true;
        reason = 'ok';
      }
    } else {
      // called === false: the tool must not have been invoked.
      passed = !called;
      reason = called ? 'tool_unexpectedly_called' : 'ok';
    }
  } else {
    const used = events.some((event) => event.event === item.event) === item.present;
    passed = terminalTrace ? used : null;
    reason = !terminalTrace ? 'trace_incomplete' : passed ? 'ok' : 'value_mismatch';
    evidence.trace_complete = terminalTrace;
  }
  return { id: item.id, passed, reason, evidence };
}

/** Map a thrown artifact accessor error onto a stable machine-readable reason. */
function classifyArtifactError(error: unknown): CheckReason {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('outside') || message.includes('leaves workspace')) {
    return 'outside_workspace';
  }
  if (message.includes('symlink')) {
    return 'symlink_rejected';
  }
  if (message.includes('missing or oversized')) {
    return 'not_found';
  }
  if (message.includes('oversized')) {
    return 'oversized';
  }
  return 'not_found';
}

function verdictOf(results: CheckResult[]): CaseVerdict {
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
    // Bind the skill before running: an unresolvable manifest is a broken suite,
    // not a failing case, so it must abort rather than silently score as a miss.
    const skill = item.skill === undefined ? null : await resolveSkill(sandbox, item.skill);
    if (skill !== null) {
      env.CRAFT_EVAL_SKILL_ID = skill.skill_id;
      env.CRAFT_EVAL_SKILL_DIGEST = skill.digest;
    }
    // Mocked MCP servers are evaluator infrastructure: their call log is the
    // evidence source for tool_call checks, so the subject cannot forge it.
    const mcp = item.mcp === undefined || item.mcp.length === 0 ? null : await startMcpServers(item.mcp, root, taskRunId);
    if (mcp !== null) {
      Object.assign(env, mcp.environment);
    }
    await mkdir(join(sandbox, 'outputs'), { recursive: true });
    const started = process.hrtime.bigint();
    let exitCode: number | null = null;
    let issue: string | null = null;
    let capturedStdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const timeoutSeconds = item.timeout_s ?? 30;
    try {
      if (item.driver === undefined) {
        const outcome = await runAdapter(item, sandbox, env, stdoutPath, stderrPath);
        exitCode = outcome.exitCode;
        issue = outcome.issue;
        capturedStdout = outcome.stdout;
      } else {
        // Server mode: start the service, run the driver to completion, then
        // stop the service. The service's own exit is irrelevant to the verdict.
        const serviceEnv = { ...env, ...(item.driver.env ?? {}) };
        const service = await startService(item, sandbox, serviceEnv);
        try {
          const driverCase: Case = { ...item, argv: item.driver.argv };
          const outcome = await runAdapter(driverCase, sandbox, env, stdoutPath, stderrPath);
          exitCode = outcome.exitCode;
          issue = outcome.issue;
          capturedStdout = outcome.stdout;
        } finally {
          await service();
        }
      }
    } finally {
      if (mcp !== null) {
        await mcp.stop();
      }
    }
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const [events, terminalTrace] = await trace(tracePath, taskRunId);
    const mcpCalls = mcp === null ? [] : await readMcpCalls(mcp.configPath);
    const taskChecks = await Promise.all(
      (item.checks ?? []).map((entry) =>
        check(entry, sandbox, exitCode, events, terminalTrace, timeoutSeconds, mcpCalls, capturedStdout),
      ),
    );
    const safetyChecks = await Promise.all(
      (item.safety_checks ?? []).map((entry) =>
        check(entry, sandbox, exitCode, events, terminalTrace, timeoutSeconds, mcpCalls, capturedStdout),
      ),
    );
    const trigger =
      item.skill === undefined || skill === null
        ? null
        : buildTrigger(item.skill, skill, events, terminalTrace);
    const taskVerdict = verdictOf(taskChecks);
    const safetyVerdict = verdictOf(safetyChecks);
    const verdict = decideVerdict(
      taskVerdict,
      safetyVerdict,
      safetyChecks,
      trigger,
      issue,
      subject.kind === 'agent',
      terminalTrace,
    );
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

/**
 * Combine the check groups into one case verdict.
 *
 * Precedence: a definite failure wins; an adapter error is `invalid` except a
 * timeout, which is `inconclusive`; anything unjudged stays `inconclusive`.
 * An agent also needs a completed host trace to be `passed`.
 */
function decideVerdict(
  taskVerdict: CaseVerdict,
  safetyVerdict: CaseVerdict,
  safetyChecks: CheckResult[],
  trigger: TriggerResult | null,
  issue: string | null,
  requiresTrace: boolean,
  terminalTrace: boolean,
): Verdict {
  if (taskVerdict === 'failed' || safetyVerdict === 'failed' || trigger?.verdict === 'failed') {
    return 'failed';
  }
  if (issue !== null) {
    return issue === 'timeout' ? 'inconclusive' : 'invalid';
  }
  if (requiresTrace && !terminalTrace) {
    return 'inconclusive';
  }
  // A skill negative case legitimately has no task checks, so an unjudged task
  // group is only inconclusive when the trigger did not already settle the case.
  const inconclusive =
    (taskVerdict === 'inconclusive' && trigger?.verdict !== 'passed') ||
    (safetyVerdict === 'inconclusive' && safetyChecks.length > 0) ||
    trigger?.verdict === 'inconclusive';
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
  stdout: Buffer<ArrayBufferLike>;
  stderr: Buffer;
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
      done({ exitCode: null, issue: `adapter_error:${(error as Error).name}`, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number | null, issue: string | null): void => {
      const mergedStdout = Buffer.concat(stdout);
      const mergedStderr = Buffer.concat(stderr);
      void writeCapture(stdoutPath, [mergedStdout], stderrPath, [mergedStderr]).then(() =>
        done({ exitCode, issue, stdout: mergedStdout, stderr: mergedStderr }),
      );
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killTree(child.pid);
      finish(null, 'timeout');
    }, (item.timeout_s ?? 30) * 1_000);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      finish(null, `adapter_error:${error.code === 'ENOENT' ? 'FileNotFoundError' : error.name}`);
    });
    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      finish(code, null);
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

interface RunPlan {
  schema: string;
  run_id: string;
  suite: Suite;
  suite_digest: string;
  subject: { kind: string; id: string; version: string; digest: string };
  runtime: Runtime;
  trials: number;
  expected: number;
}

function missingResult(caseId: string, trial: number): CaseResult {
  return {
    case_id: caseId,
    trial,
    task_run_id: null,
    verdict: 'missing',
    task_verdict: 'missing',
    safety_verdict: 'missing',
    trigger: null,
    issue: null,
    exit_code: null,
    duration_ms: null,
    cost_units: null,
    checks: [],
    safety_checks: [],
    stdout_sha256: null,
    stderr_sha256: null,
    trace_sha256: null,
    trace_complete: false,
  };
}

async function loadRun(path: string): Promise<{ plan: RunPlan; results: CaseResult[] }> {
  const root = resolve(path);
  const plan = (await load(join(root, 'plan.json'))) as unknown as RunPlan;
  if (plan.schema !== SCHEMA || digest(plan.suite) !== plan.suite_digest) {
    throw new Error('run plan is invalid or changed');
  }
  const results: CaseResult[] = [];
  for (const item of plan.suite.cases) {
    for (let trial = 1; trial <= plan.trials; trial += 1) {
      const resultPath = join(root, 'results', `${item.id}-${trial}.json`);
      const info = await stat(resultPath).catch(() => null);
      if (info === null || !info.isFile()) {
        results.push(missingResult(item.id, trial));
        continue;
      }
      const result = (await load(resultPath)) as unknown as CaseResult;
      if (result.case_id !== item.id || result.trial !== trial) {
        throw new Error('result does not match run plan');
      }
      results.push(result);
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
  const count = (verdict: Verdict): number => results.filter((item) => item.verdict === verdict).length;
  const missing = count('missing');
  const inconclusive = count('inconclusive');
  const invalid = count('invalid');
  return {
    run_id: plan.run_id,
    suite_id: plan.suite.suite_id,
    subject: plan.subject,
    partition: plan.suite.partition,
    expected: plan.expected,
    recorded: plan.expected - missing,
    passed: count('passed'),
    failed: count('failed'),
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

export interface MetricSummary {
  observed: number;
  mean: number | null;
}

export interface Comparison {
  status: 'comparable' | 'inconclusive';
  subject_kind: string;
  baseline_run_id: string;
  candidate_run_id: string;
  expected_pairs: number;
  measured_pairs: number;
  unmeasured_pairs: number;
  candidate_wins: number;
  baseline_wins: number;
  ties: number;
  one_sided_p: number | null;
  candidate_trigger_failures: number;
  candidate_safety_failures: number;
  independent_task_runs: boolean;
  gateway_observed_triggers: boolean;
  unobserved_triggers: number;
  skill_gain_supported: boolean;
  duration_ms: { baseline: MetricSummary; candidate: MetricSummary };
  cost_units: { baseline: MetricSummary; candidate: MetricSummary };
}

export async function compareRuns(baselinePath: string, candidatePath: string): Promise<Comparison> {
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
  // Both runs list results in suite-case order repeated per trial, so index i of
  // either run is the same (case, trial) pair as index i of the other.
  const casesInOrder: Case[] = [];
  for (const item of left.suite.cases) {
    for (let index = 0; index < left.trials; index += 1) {
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
  const subjectKind = left.suite.subject_kind;
  const positive = left.suite.cases.filter((item) => item.skill?.should_trigger === true).length;
  const negative = left.suite.cases.filter((item) => item.skill?.should_trigger === false).length;
  const triggerFailures = candidate.results.filter(
    (item) => item.trigger !== null && item.trigger.verdict !== 'passed',
  ).length;
  // A gain claim needs evaluator-observed invocation. Self-reported triggers can
  // diagnose a skill but cannot prove it helped, so they never satisfy the gate.
  const gatewayObserved = candidate.results
    .filter((item) => item.trigger !== null)
    .every((item) => item.trigger?.evidence === 'gateway');
  const unobservedTriggers = candidate.results.filter(
    (item) => item.trigger !== null && item.trigger.evidence === 'unobserved',
  ).length;
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
    gatewayObserved &&
    unobservedTriggers === 0 &&
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
    gateway_observed_triggers: gatewayObserved,
    unobserved_triggers: unobservedTriggers,
    skill_gain_supported: gain,
    duration_ms: { baseline: metric(baseline.results, 'duration_ms'), candidate: metric(candidate.results, 'duration_ms') },
    cost_units: { baseline: metric(baseline.results, 'cost_units'), candidate: metric(candidate.results, 'cost_units') },
  };
}
