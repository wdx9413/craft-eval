/**
 * Run trusted local adapters and judge their observed effects.
 *
 * Only the adapter command executes work. This module never runs a shell, model
 * judge, or promotion action. Cases and reports are JSON so other layers can use
 * the same contract without depending on Craft's storage or runtime.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startHttpMocks, type HttpMockServer } from './http-mock.js';

import {
  validateCaseMetadata,
  validateCaseKeys,
  validateSuiteMetadata,
  type CaseMetadata,
  type SuiteMetadata,
} from './contract.js';
import {
  binaryEffect,
  pairedContinuousEffect,
  summarizeContinuous,
  type BinaryPair,
  type ContinuousPair,
} from './statistics.js';

export const SCHEMA = 'craft-eval.eval.v1';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_KEYS = ['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'] as const;
const MAX_TRACE_BYTES = 1_000_000;
const MAX_JSON_BYTES = 1_000_000;

export interface Check {
  id: string;
  kind:
    | 'exit_code'
    | 'file_exists'
    | 'json_equals'
    | 'trace_event'
    | 'script'
    | 'tool_call'
    | 'stdout_contains'
    | 'stdout_not_contains'
    | 'model_graded';
  /** Relative weight for assert-set scoring (default 1). */
  weight?: number;
  /** Optional judge name, used for per-judge reporting. */
  judge?: string;
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

export interface Case extends CaseMetadata {
  id: string;
  /** Command for a plain local subject. Mutually exclusive with `prompt`. */
  argv?: string[];
  /** Task prompt for a subject with a `host` adapter. Mutually exclusive with `argv`. */
  prompt?: string;
  timeout_s?: number;
  checks?: Check[];
  safety_checks?: Check[];
  skill?: SkillBinding;
  /** Mocked MCP servers started by the evaluator for this case. */
  mcp?: McpServerSpec[];
  /**
   * Evaluator-owned HTTP fixture servers. Each entry exposes a base URL through
   * the named env var, so a business MCP can be graded offline without editing
   * its source.
   */
  http_mock?: HttpMockServer[];
  /**
   * Server-mode case: `argv` starts a long-running service and `driver.argv`
   * exercises it to completion. The evaluator terminates the service after the
   * driver exits; trace, checks and stdout/stderr all belong to the driver.
   * `driver.env` is layered over the shared environment for the service process
   * only, so a host script can distinguish its role from the driver's.
   */
  /**
   * Per-case workspace, resolved relative to the `--workspace` directory given
   * to `run`. Cases that need different initial state (a seeded tree, a fixture
   * set) point at their own directory instead of sharing one mutable copy.
   */
  workspace?: string;
  /**
   * Run against the workspace in place instead of a copy. Only for cases whose
   * subject is the checkout itself (build, own test suite): the copy skips
   * `node_modules` and `dist`, so a build cannot succeed inside it. Such a case
   * may write to the subject, which is why this is opt-in per case.
   */
  in_place?: boolean;
  driver?: { argv: string[]; env?: Record<string, string> };
  /**
   * Preconditions. When unmet the case is recorded as `not_applicable` rather
   * than `failed`, so a missing host package is not counted as a product defect.
   */
  requires?: CaseRequirement;
  /** Optional source language tag, used for per-language reporting. */
  language?: string;
  /**
   * Assert-set threshold for task checks: weighted pass ratio in [0,1] required
   * to pass. Defaults to 1 (every check must pass). Safety checks always
   * require 1 and ignore this field.
   */
  threshold?: number;
  [key: string]: unknown;
}

export interface Suite extends SuiteMetadata {
  schema: string;
  suite_id: string;
  subject_kind: string;
  /** Case-set role. Deliberately not named `stage`: craft has a separate, unrelated notion of stage. */
  partition: Partition;
  sanitized: boolean;
  approved_by?: string;
  cases: Case[];
  business?: BusinessModel;
  [key: string]: unknown;
}

/** Whether a case set may inform delivery claims. */
export type Partition = 'development' | 'held_out';

export interface Subject {
  kind: string;
  id: string;
  version: string;
  env?: Record<string, string>;
  /** Optional evaluator-launched agent host. A plain argv subject leaves this unset. */
  host?: HostConfig;
  [key: string]: unknown;
}

export interface HostConfig {
  kind: 'codex' | 'claude';
  binary: string;
  /** Trusted wrapper arguments inserted before adapter arguments, e.g. a test launcher. */
  args_prefix?: string[];
  /** Requested model alias. It is recorded, never assumed to be what the host used. */
  model?: string;
  /** Codex sandbox policy. Defaults to read-only. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Explicit host environment overrides, such as CODEX_HOME or CLAUDE_CONFIG_DIR. */
  env?: Record<string, string>;
}

/**
 * What the evaluator observed about the host process. `observed_models` comes
 * only from host event output; requested aliases are kept separately. A free
 * route alias is not evidence that the call was free.
 */
export interface HostObservation {
  adapter: 'codex' | 'claude';
  requested_model: string | null;
  observed_models: string[];
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  cost_usd: number | null;
  tool_calls: number;
}

export type Runtime = Record<(typeof RUNTIME_KEYS)[number], string>;

export type Verdict = 'passed' | 'failed' | 'inconclusive' | 'invalid' | 'missing' | 'not_applicable';
/** Outcome of one check group; `missing` only appears for an unrecorded case. */
export type CaseVerdict = 'passed' | 'failed' | 'inconclusive' | 'missing' | 'not_applicable';

export interface CaseRequirement {
  /** Commands that must exist on PATH. */
  commands?: string[];
  /** Environment variables that must be set and non-empty. */
  env?: string[];
  /** Python modules that must be importable via `py -3 -c "import <name>"`. */
  python_modules?: string[];
}

/** A business invariant derived from domain rules; cases cite it via case_id lists. */
export interface BusinessInvariant {
  id: string;
  /** Natural-language statement of what must always hold. */
  statement: string;
  /** Case IDs that exercise the invariant positively. */
  positive_cases: string[];
  /** Case IDs that attempt to violate it. */
  negative_cases: string[];
}

/** A business lifecycle transition; `from === null` means "any state". */
export interface BusinessTransition {
  id: string;
  entity: string;
  from: string | null;
  to: string;
  /** Whether this transition must be allowed by the subject. */
  allowed: boolean;
  /** Case IDs exercising this transition. */
  cases: string[];
}

/** Suite-level business model, used to derive coverage checks. */
export interface BusinessModel {
  invariants?: BusinessInvariant[];
  transitions?: BusinessTransition[];
  /** Numeric rules with boundary/equivalence points that must each be hit. */
  rules?: BusinessRule[];
  /** Incident sources that must have corresponding held-out cases. */
  incidents?: Array<{ id: string; source: string; case_ids: string[] }>;
}

export interface BusinessRule {
  id: string;
  statement: string;
  /** Parameter name, e.g. "coupon_threshold". */
  parameter: string;
  /**
   * Boundary or equivalence points. Each must be exercised by at least one case;
   * e.g. 199/200/201 for a "满 200 减 30" coupon.
   */
  boundaries: Array<{ value: number; cases: string[] }>;
}

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
  | 'stdout_present'
  | 'judge_error';

export interface CheckResult {
  id: string;
  passed: boolean | null;
  reason: CheckReason;
  evidence: { kind: string; [key: string]: unknown };
  weight?: number;
  judge?: string;
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
  gateway_sha256: string | null;
  trace_complete: boolean;
  host: HostObservation | null;
}

interface TraceEvent {
  source?: unknown;
  task_run_id?: unknown;
  event?: unknown;
  skill_id?: unknown;
  cost_units?: unknown;
  [key: string]: unknown;
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

/**
 * Expand the `{{subjects}}` placeholder at run time, not at load time, so the
 * suite digest stays machine-independent. Override with
 * CRAFT_EVAL_SUBJECTS_ROOT when the checkouts live elsewhere.
 */
function expandSubjects(value: string): string {
  if (!value.includes('{{subjects}}')) {
    return value;
  }
  const root = process.env.CRAFT_EVAL_SUBJECTS_ROOT ?? resolve(process.cwd(), '..', 'eval-subjects');
  return value.replaceAll('{{subjects}}', root);
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
    if (check.weight !== undefined && (typeof check.weight !== 'number' || !Number.isFinite(check.weight) || check.weight <= 0)) {
      throw new Error('check.weight must be a positive number');
    }
    if (check.judge !== undefined) {
      identifier(check.judge, 'check.judge');
    }
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
    } else if (kind === 'model_graded') {
      if (
        !Array.isArray(check.command) ||
        check.command.length === 0 ||
        check.command.some((arg) => typeof arg !== 'string' || arg === '')
      ) {
        throw new Error('model_graded requires a non-empty command array');
      }
      relativePath(check.answer, 'model_graded.answer');
      if (
        check.threshold !== undefined &&
        (typeof check.threshold !== 'number' || !Number.isFinite(check.threshold) || check.threshold < 0 || check.threshold > 1)
      ) {
        throw new Error('model_graded.threshold must be within 0..1');
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
  validateSuiteMetadata(suite);
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
    validateCaseKeys(item, `case ${caseId}`);
    validateCaseMetadata(
      {
        tags: item.tags,
        category: item.category,
        difficulty: item.difficulty,
        risk: item.risk,
        provenance: item.provenance,
        owner: item.owner,
        expected_behavior: item.expected_behavior,
        claim: item.claim,
      },
      `case ${caseId}`,
    );
    if (seen.has(caseId)) {
      throw new Error('case IDs must be unique');
    }
    seen.add(caseId);
    if (item.prompt !== undefined && (typeof item.prompt !== 'string' || item.prompt.trim() === '')) {
      throw new Error(`case ${caseId} prompt must be a non-empty string`);
    }
    if (item.prompt !== undefined && item.argv !== undefined) {
      throw new Error(`case ${caseId} cannot set both argv and prompt`);
    }
    if (item.prompt === undefined && item.argv === undefined) {
      throw new Error(`case ${caseId} needs argv or prompt`);
    }
    if (item.argv !== undefined) {
      const argv = item.argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg === '')) {
        throw new Error(`case ${caseId} needs non-empty argv strings`);
      }
    }
    if (item.driver !== undefined) {
      if (item.prompt !== undefined) {
        throw new Error(`case ${caseId} driver cannot be combined with a host prompt`);
      }
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
    const httpMocks = item.http_mock;
    if (httpMocks !== undefined) {
      if (!Array.isArray(httpMocks) || httpMocks.length > 8) {
        throw new Error(`case ${caseId} http_mock must be an array of at most 8 servers`);
      }
      const envNames = new Set<string>();
      for (const server of httpMocks) {
        if (server === null || typeof server !== 'object' || Array.isArray(server)) {
          throw new Error(`case ${caseId} http_mock servers must be objects`);
        }
        const env = server.env;
        if (typeof env !== 'string' || !ENV_KEY.test(env) || env.startsWith('CRAFT_EVAL_')) {
          throw new Error(`case ${caseId} http_mock.env must be a safe environment variable name`);
        }
        if (envNames.has(env)) {
          throw new Error(`case ${caseId} http_mock env names must be unique`);
        }
        envNames.add(env);
        const routes = server.routes;
        if (!Array.isArray(routes) || routes.length === 0 || routes.length > 64) {
          throw new Error(`case ${caseId} http_mock ${env} needs 1..64 routes`);
        }
        for (const route of routes) {
          if (route === null || typeof route !== 'object' || Array.isArray(route)) {
            throw new Error(`case ${caseId} http_mock routes must be objects`);
          }
          if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
            throw new Error(`case ${caseId} http_mock route path must start with /`);
          }
          if (route.status !== undefined && (!Number.isInteger(route.status) || route.status < 100 || route.status > 599)) {
            throw new Error(`case ${caseId} http_mock route status must be 100..599`);
          }
        }
      }
    }
    const requirement = item.requires;
    if (requirement !== undefined) {
      if (requirement === null || typeof requirement !== 'object' || Array.isArray(requirement)) {
        throw new Error(`case ${caseId} requires must be an object`);
      }
      for (const [key, values] of Object.entries(requirement as Record<string, unknown>)) {
        if (key !== 'commands' && key !== 'env' && key !== 'python_modules') {
          throw new Error(`case ${caseId} requires contains unsupported field: ${key}`);
        }
        if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value === '')) {
          throw new Error(`case ${caseId} requires.${key} must be non-empty strings`);
        }
      }
    }
    if (item.language !== undefined && (typeof item.language !== 'string' || item.language === '')) {
      throw new Error(`case ${caseId} language must be a non-empty string`);
    }
    if (
      item.threshold !== undefined &&
      (typeof item.threshold !== 'number' || !Number.isFinite(item.threshold) || item.threshold < 0 || item.threshold > 1)
    ) {
      throw new Error(`case ${caseId} threshold must be within 0..1`);
    }
    if (item.threshold !== undefined && safety.length > 0) {
      // Safety stays all-or-nothing regardless of the task assert-set threshold.
      void safety;
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
  const business = (suite as { business?: unknown }).business;
  if (business !== undefined) {
    if (business === null || typeof business !== 'object' || Array.isArray(business)) {
      throw new Error('suite.business must be an object');
    }
    const model = business as Record<string, unknown>;
    const allowed = new Set(['invariants', 'transitions', 'rules', 'incidents']);
    if (Object.keys(model).some((key) => !allowed.has(key))) {
      throw new Error('suite.business contains unsupported fields');
    }
    const invariants = model.invariants;
    if (invariants !== undefined) {
      if (!Array.isArray(invariants) || invariants.length > 256) {
        throw new Error('suite.business.invariants must be an array of at most 256 entries');
      }
      for (const entry of invariants) {
        const item = entry as Record<string, unknown>;
        identifier(item.id as string, 'business.invariant.id');
        if (typeof item.statement !== 'string' || item.statement === '') {
          throw new Error('business.invariant.statement must be a non-empty string');
        }
        for (const key of ['positive_cases', 'negative_cases'] as const) {
          if (!Array.isArray(item[key]) || (item[key] as unknown[]).some((value) => typeof value !== 'string')) {
            throw new Error(`business.invariant.${key} must be an array of case ids`);
          }
        }
      }
    }
    const transitions = model.transitions;
    if (transitions !== undefined) {
      if (!Array.isArray(transitions) || transitions.length > 256) {
        throw new Error('suite.business.transitions must be an array of at most 256 entries');
      }
      for (const entry of transitions) {
        const item = entry as Record<string, unknown>;
        identifier(item.id as string, 'business.transition.id');
        if (typeof item.entity !== 'string' || item.entity === '') {
          throw new Error('business.transition.entity must be a non-empty string');
        }
        if (item.from !== null && (typeof item.from !== 'string' || item.from === '')) {
          throw new Error('business.transition.from must be a state name or null');
        }
        if (typeof item.to !== 'string' || item.to === '') {
          throw new Error('business.transition.to must be a non-empty string');
        }
        if (typeof item.allowed !== 'boolean') {
          throw new Error('business.transition.allowed must be a boolean');
        }
        if (!Array.isArray(item.cases) || (item.cases as unknown[]).some((value) => typeof value !== 'string')) {
          throw new Error('business.transition.cases must be an array of case ids');
        }
      }
    }
    const rules = model.rules;
    if (rules !== undefined) {
      if (!Array.isArray(rules) || rules.length > 256) {
        throw new Error('suite.business.rules must be an array of at most 256 entries');
      }
      for (const entry of rules) {
        const item = entry as Record<string, unknown>;
        identifier(item.id as string, 'business.rule.id');
        if (typeof item.statement !== 'string' || item.statement === '') {
          throw new Error('business.rule.statement must be a non-empty string');
        }
        if (typeof item.parameter !== 'string' || item.parameter === '') {
          throw new Error('business.rule.parameter must be a non-empty string');
        }
        if (!Array.isArray(item.boundaries) || item.boundaries.length === 0) {
          throw new Error('business.rule.boundaries must be a non-empty array');
        }
        for (const boundary of item.boundaries) {
          const point = boundary as Record<string, unknown>;
          if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
            throw new Error('business.rule boundary value must be a finite number');
          }
          if (!Array.isArray(point.cases) || (point.cases as unknown[]).some((value) => typeof value !== 'string')) {
            throw new Error('business.rule boundary cases must be an array of case ids');
          }
        }
      }
    }
    const incidents = model.incidents;
    if (incidents !== undefined) {
      if (!Array.isArray(incidents) || incidents.length > 256) {
        throw new Error('suite.business.incidents must be an array of at most 256 entries');
      }
      for (const entry of incidents) {
        const item = entry as Record<string, unknown>;
        identifier(item.id as string, 'business.incident.id');
        if (typeof item.source !== 'string' || item.source === '') {
          throw new Error('business.incident.source must be a non-empty string');
        }
        if (!Array.isArray(item.case_ids) || (item.case_ids as unknown[]).some((value) => typeof value !== 'string')) {
          throw new Error('business.incident.case_ids must be an array of case ids');
        }
      }
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
  if (subject.host !== undefined) {
    const host = subject.host;
    if (host === null || typeof host !== 'object' || Array.isArray(host)) {
      throw new Error('subject.host must be an object');
    }
    const config = host as Record<string, unknown>;
    const allowed = new Set(['kind', 'binary', 'args_prefix', 'model', 'sandbox', 'env']);
    if (Object.keys(config).some((key) => !allowed.has(key))) {
      throw new Error('subject.host contains unsupported fields');
    }
    if (config.kind !== 'codex' && config.kind !== 'claude') {
      throw new Error('subject.host.kind must be codex or claude');
    }
    if (typeof config.binary !== 'string' || config.binary === '') {
      throw new Error('subject.host.binary must be a non-empty string');
    }
    if (
      config.args_prefix !== undefined &&
      (!Array.isArray(config.args_prefix) || config.args_prefix.some((value) => typeof value !== 'string' || value === ''))
    ) {
      throw new Error('subject.host.args_prefix must be an array of non-empty strings');
    }
    if (config.model !== undefined && (typeof config.model !== 'string' || config.model === '')) {
      throw new Error('subject.host.model must be a non-empty string');
    }
    if (
      config.sandbox !== undefined &&
      config.sandbox !== 'read-only' &&
      config.sandbox !== 'workspace-write' &&
      config.sandbox !== 'danger-full-access'
    ) {
      throw new Error('subject.host.sandbox must be read-only, workspace-write or danger-full-access');
    }
    validateHostEnv(config.env);
  }
  return subject as unknown as Subject;
}

function validateHostEnv(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('subject.host.env must contain string environment variables');
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ENV_KEY.test(key) || typeof item !== 'string') {
      throw new Error('subject.host.env must contain string environment variables');
    }
    if (key.startsWith('CRAFT_EVAL_') || key.startsWith('DYLD_') || key.startsWith('LD_')) {
      throw new Error('subject.host.env cannot override evaluator controls');
    }
  }
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

async function artifact(sandbox: string, relativeName: string, outputDir?: string): Promise<string> {
  // `outputs/...` is evaluator scratch space. Normally it lives inside the
  // sandbox. An in-place case passes an outputDir that already points at the
  // outputs directory itself, so the prefix is stripped before resolving there;
  // without the override, behaviour is exactly as before.
  if (outputDir !== undefined && (relativeName === 'outputs' || /^outputs[\\/]/.test(relativeName))) {
    const stripped = relativeName.replace(/^outputs[\\/]?/, '');
    return stripped === '' ? resolve(outputDir) : artifact(outputDir, stripped);
  }
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

/** Parse an evaluator-owned or subject-owned JSONL trace and require one source. */
async function trace(path: string, taskRunId: string, source: 'host' | 'gateway'): Promise<[TraceEvent[], boolean]> {
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
    if (events.some((event) => event.task_run_id !== taskRunId || event.source !== source)) {
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
  /** Tail of the grading script's stderr, kept for diagnosis. */
  stderr: string;
  /** Tail of the grading script's stdout, kept for diagnosis. */
  stdout: string;
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
  extraEnv?: Record<string, string>,
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
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stdoutBytes = 0;
    const MAX_SCRIPT_OUTPUT = 4_000;
    const stderrTail = (): string => Buffer.concat(stderrChunks).toString('utf8').slice(-2_000);
    const stdoutTail = (): string => Buffer.concat(stdoutChunks).toString('utf8').slice(-2_000);
    try {
      child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd: sandbox,
        env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? '', ...(extraEnv ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      done({ exitCode: null, issue: (error as Error).name, stderr: '', stdout: '' });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_SCRIPT_OUTPUT) {
        return;
      }
      const room = MAX_SCRIPT_OUTPUT - stdoutBytes;
      const take = chunk.length > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
      stdoutChunks.push(take);
      stdoutBytes += take.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_SCRIPT_OUTPUT) {
        return;
      }
      const room = MAX_SCRIPT_OUTPUT - stderrBytes;
      const take = chunk.length > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
      stderrChunks.push(take);
      stderrBytes += take.length;
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killTree(child.pid);
      done({ exitCode: null, issue: 'timeout', stderr: stderrTail(), stdout: stdoutTail() });
    }, timeoutSeconds * 1_000);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      done({ exitCode: null, issue: error.code ?? error.name, stderr: stderrTail(), stdout: stdoutTail() });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      done({ exitCode: code, issue: null, stderr: stderrTail(), stdout: stdoutTail() });
    });
  });
}

/**
 * Decide the trigger verdict from the strongest evidence available.
 *
 * A `gateway` event is produced by the evaluator from a host process it
 * launched, so it is authoritative. Events with `source: "host"` are written by
 * the subject: they are useful for diagnosis but can never support a gain
 * claim. A complete subject trace without an invocation is still unobserved,
 * because a subject can omit the event.
 */
function buildTrigger(
  binding: SkillBinding,
  skill: ResolvedSkill,
  hostEvents: TraceEvent[],
  gatewayEvents: TraceEvent[],
  terminalHost: boolean,
  terminalGateway: boolean,
  gatewayOwned: boolean,
): TriggerResult {
  const skillDigest = skill.digest;
  if (!terminalHost && !terminalGateway) {
    return {
      expected: binding.should_trigger,
      used: null,
      evidence: 'unobserved',
      skill_digest: skillDigest,
      verdict: 'inconclusive',
    };
  }
  const matching = (events: TraceEvent[], source: 'host' | 'gateway') =>
    events.some(
      (event) => event.event === 'skill.invoked' && event.skill_id === binding.skill_id && event.source === source,
    );
  const gatewayUsed = gatewayOwned && terminalGateway && matching(gatewayEvents, 'gateway');
  const selfUsed = terminalHost && matching(hostEvents, 'host');
  if (gatewayOwned && terminalGateway) {
    const used = gatewayUsed;
    return {
      expected: binding.should_trigger,
      used,
      evidence: 'gateway',
      skill_digest: skillDigest,
      verdict: used === binding.should_trigger ? 'passed' : 'failed',
    };
  }
  if (selfUsed) {
    return {
      expected: binding.should_trigger,
      used: true,
      evidence: 'self_reported',
      skill_digest: skillDigest,
      verdict: true === binding.should_trigger ? 'passed' : 'failed',
    };
  }
  // A complete subject-written trace with no invocation is not proof of a
  // negative: the subject could simply have omitted the event.
  return {
    expected: binding.should_trigger,
    used: null,
    evidence: 'unobserved',
    skill_digest: skillDigest,
    verdict: 'inconclusive',
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
      const argv = item.argv ?? [];
      child = spawn(argv[0] ?? '', argv.slice(1), {
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
    let started = false;
    child.once('spawn', () => {
      started = true;
      resolveStarted(async () => {
        killTree(child.pid);
        // Give the process a moment to die so the temp tree can be removed.
        await new Promise((done) => setTimeout(done, 120));
      });
    });
    child.once('error', () => {
      // A missing service binary is a driver-visible infrastructure failure.
      if (!started) {
        resolveStarted(async () => {});
      }
    });
  });
}

/**
 * Run an external judge command. It receives the answer path and rubric via
 * env and must print JSON `{ "score": 0..1, "reason"?: string }`. Keeping the
 * judge as a command makes model choice pluggable and keeps craft-eval free of
 * a hard model dependency.
 */
async function runJudge(
  command: string[],
  sandbox: string,
  timeoutSeconds: number,
  env: Record<string, string>,
): Promise<{ exitCode: number | null; issue: string | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(command[0] ?? '', command.slice(1), {
        cwd: sandbox,
        env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      done({ exitCode: null, issue: (error as Error).name, stdout: '', stderr: '' });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number | null, issue: string | null): void => {
      done({
        exitCode,
        issue,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8').slice(-2_000),
      });
    };
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child.pid);
      finish(null, 'timeout');
    }, timeoutSeconds * 1_000);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(null, error.code ?? error.name);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(code, null);
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
  outputDir?: string,
  caseEnv?: Record<string, string>,
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
      const path = await artifact(sandbox, relativePath(item.path, 'file_exists.path'), outputDir);
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
      const path = await artifact(sandbox, relativePath(item.path, 'json_equals.path'), outputDir);
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
      // A bare hash cannot explain a mismatch. Keep the expected and observed
      // values (bounded) so a failed json_equals is diagnosable offline.
      evidence.expected = item.equals;
      const observed = JSON.stringify(value);
      evidence.actual =
        observed !== undefined && observed.length > 500 ? `${observed.slice(0, 500)}...` : value;
    } catch (error) {
      passed = false;
      reason = error instanceof SyntaxError ? 'invalid_json' : classifyArtifactError(error);
    }
    evidence.path = item.path;
  } else if (kind === 'script') {
    const scriptPath = await artifact(sandbox, relativePath(item.path, 'script.path'), outputDir).catch(() => null);
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
      caseEnv,
    );
      evidence.exit_code = outcome.exitCode;
      // Keep the tail of the grading script's stderr so a failed script reports
      // why (missing marker, forbidden phrase, crash) instead of only an exit code.
      if (outcome.stderr !== '') {
        evidence.stderr_tail = outcome.stderr;
      }
      if (outcome.stdout !== '') {
        evidence.stdout_tail = outcome.stdout;
      }
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
  } else if (kind === 'model_graded') {
    const answerPath = await artifact(sandbox, relativePath(item.answer, 'model_graded.answer'), outputDir).catch(() => null);
    if (answerPath === null) {
      passed = false;
      reason = 'not_found';
    } else {
      const judgeEnv: Record<string, string> = {
        CRAFT_EVAL_JUDGE_ANSWER: answerPath,
        ...(item.rubric === undefined ? {} : { CRAFT_EVAL_JUDGE_RUBRIC: String(item.rubric) }),
        ...(caseEnv ?? {}),
      };
      const outcome = await runJudge(
        (item.command as string[]) ?? [],
        sandbox,
        Math.max(1, Math.floor(timeoutSeconds)),
        judgeEnv,
      );
      evidence.exit_code = outcome.exitCode;
      if (outcome.stderr !== '') evidence.judge_stderr_tail = outcome.stderr;
      if (outcome.issue !== null) {
        passed = null;
        reason = 'judge_error';
        evidence.issue = outcome.issue;
      } else {
        try {
          const parsed = JSON.parse(outcome.stdout) as { score?: unknown; reason?: unknown };
          const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : NaN;
          if (Number.isNaN(score)) throw new Error('missing numeric score');
          const threshold = typeof item.threshold === 'number' ? item.threshold : 1;
          passed = score >= threshold;
          reason = passed ? 'ok' : 'value_mismatch';
          evidence.score = score;
          evidence.threshold = threshold;
          if (typeof parsed.reason === 'string') evidence.judge_reason = parsed.reason;
        } catch (error) {
          passed = null;
          reason = 'judge_error';
          evidence.issue = `invalid judge output: ${(error as Error).message}`;
          evidence.judge_stdout_tail = outcome.stdout.slice(-500);
        }
      }
    }
    evidence.answer = item.answer;
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
  return {
    id: item.id,
    passed,
    reason,
    evidence,
    ...(typeof item.weight === 'number' ? { weight: item.weight } : {}),
    ...(item.judge === undefined ? {} : { judge: item.judge }),
  };
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

function verdictOf(results: CheckResult[], threshold = 1): CaseVerdict {
  if (results.length === 0) {
    return 'inconclusive';
  }
  // An assert-set threshold below 1 allows weighted partial passes. Any null
  // still stays inconclusive and any failing check still counts against the
  // ratio, so safety-style all-or-nothing semantics are threshold === 1.
  if (results.some((item) => item.passed === false)) {
    const total = results.reduce((sum, item) => sum + (item.weight ?? 1), 0);
    const achieved = results.reduce((sum, item) => sum + (item.passed === true ? (item.weight ?? 1) : 0), 0);
    if (threshold >= 1 || total === 0 || achieved / total >= threshold) {
      return threshold >= 1 ? 'failed' : 'passed';
    }
    return 'failed';
  }
  if (results.some((item) => item.passed === null)) {
    return 'inconclusive';
  }
  return 'passed';
}

const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL'];

/** Return a short unmet-requirement tag, or null when the case can run. */
function unmetRequirement(requires?: CaseRequirement): string | null {
  if (requires === undefined) {
    return null;
  }
  for (const name of requires.env ?? []) {
    if (process.env[name] === undefined || process.env[name] === '') {
      return `env:${name}`;
    }
  }
  for (const command of requires.commands ?? []) {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    if (probe.error !== undefined) {
      return `command:${command}`;
    }
  }
  for (const module of requires.python_modules ?? []) {
    // The interpreter name differs across hosts (py -3 / python3 / python).
    let importable = false;
    for (const [command, prefix] of [['py', ['-3']], ['python3', []], ['python', []]] as const) {
      const probe = spawnSync(command, [...prefix, '-c', `import ${module}`], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000,
      });
      if (probe.error === undefined) {
        importable = probe.status === 0;
        break;
      }
    }
    if (!importable) {
      return `python_module:${module}`;
    }
  }
  return null;
}

async function oneCase(
  item: Case,
  subject: Subject,
  workspace: string,
  runId: string,
  trial: number,
  sharedSandbox?: string,
  keepTraces = false,
  runDir?: string,
): Promise<CaseResult> {
  const unmet = unmetRequirement(item.requires);
  if (unmet !== null) {
    return {
      case_id: item.id,
      trial,
      task_run_id: null,
      verdict: 'not_applicable',
      task_verdict: 'not_applicable',
      safety_verdict: null,
      trigger: null,
      issue: `requirement_unmet:${unmet}`,
      exit_code: null,
      duration_ms: 0,
      cost_units: null,
      checks: [],
      safety_checks: [],
      stdout_sha256: null,
      stderr_sha256: null,
      trace_sha256: null,
      gateway_sha256: null,
      trace_complete: false,
      host: null,
    };
  }
  const taskRunId = randomUUID().replace(/-/g, '');
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-case-'));
  // Capture paths recorded here so the finally block can copy them out even when
  // a check throws. They are null unless --keep-traces is requested.
  const captures: Record<string, string> = keepTraces && runDir !== undefined
    ? {
        stdout: join(root, 'stdout'),
        stderr: join(root, 'stderr'),
        'host-trace': join(root, 'host-trace.jsonl'),
        'gateway-trace': join(root, 'gateway-trace.jsonl'),
      }
    : {};
  // Set once the sandbox output directory is known; finally copies it out when
  // --keep-traces is on, so graders and artifacts can be reviewed after the run.
  let artifactsDir: string | null = null;
  try {
    // In-place cases run against the checkout itself: the copy deliberately
    // skips node_modules/dist, so a build or the subject's own suite cannot run
    // inside it. Everything else keeps the isolation.
    const sandbox = sharedSandbox ?? (item.in_place === true ? workspace : join(root, 'workspace'));
    if (sharedSandbox === undefined && item.in_place !== true) {
      await workspaceCopy(workspace, sandbox);
    }
    // Outputs sit inside the sandbox. An in-place case has no sandbox of its
    // own, so it redirects outputs beside the case root; the subject checkout is
    // never written to either way.
    const outputOverride =
      item.in_place === true && sharedSandbox === undefined ? join(root, 'outputs') : undefined;
    const outputDir = outputOverride ?? join(sandbox, 'outputs');
    await mkdir(outputDir, { recursive: true });
    artifactsDir = outputDir;
    const tracePath = join(root, 'host-trace.jsonl');
    const gatewayPath = join(root, 'gateway-trace.jsonl');
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
      // The adapter must write where the checks will look, which for an in-place
      // case is the redirect target rather than the sandbox.
      CRAFT_EVAL_OUTPUT_DIR: outputOverride ?? outputDir,
    });
    Object.assign(
      env,
      Object.fromEntries(Object.entries(subject.env ?? {}).map(([key, value]) => [key, expandSubjects(value)])),
    );
    if (subject.host !== undefined) {
      Object.assign(env, subject.host.env ?? {});
    }
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
    // HTTP fixtures are evaluator-owned: the subject only sees a base URL, so a
    // business MCP that normally calls a SaaS API can be graded offline.
    const httpMock =
      item.http_mock === undefined || item.http_mock.length === 0 ? null : await startHttpMocks(item.http_mock);
    if (httpMock !== null) {
      Object.assign(env, httpMock.environment);
    }
    const started = process.hrtime.bigint();
    let exitCode: number | null = null;
    let issue: string | null = null;
    let capturedStdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const timeoutSeconds = item.timeout_s ?? 30;
    try {
      if (item.driver === undefined) {
        const host = subject.host;
        const hostInput =
          host === undefined || item.prompt === undefined
            ? undefined
            : hostArgv(host, sandbox, item.prompt);
        const outcome = await runAdapter(
          { ...item, argv: item.argv === undefined ? undefined : item.argv.map(expandSubjects) },
          sandbox,
          env,
          stdoutPath,
          stderrPath,
          hostInput,
        );
        exitCode = outcome.exitCode;
        issue = outcome.issue;
        capturedStdout = outcome.stdout;
      } else {
        // Server mode: start the service, run the driver to completion, then
        // stop the service. The service's own exit is irrelevant to the verdict.
        const serviceEnv = { ...env, ...(item.driver.env ?? {}) };
        const service = await startService(
          { ...item, argv: item.argv === undefined ? undefined : item.argv.map(expandSubjects) },
          sandbox,
          serviceEnv,
        );
        try {
          const driverCase: Case = { ...item, argv: item.driver.argv.map(expandSubjects) };
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
      if (httpMock !== null) {
        await httpMock.stop();
      }
    }
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const [hostEvents, hostTerminal] = await trace(tracePath, taskRunId, 'host');
    const host = subject.host;
    const parsedHost = host === undefined ? null : parseHost(host, capturedStdout, taskRunId);
    const hostCanObserveSkill = host !== undefined && hostCapableOfSkillEvents(host);
    // Gateway evidence exists only in evaluator memory after parsing the Host
    // process output. Never read it back from disk: the subject can derive this
    // path from CRAFT_EVAL_TRACE_PATH and forge the file.
    const gatewayEvents = parsedHost?.events ?? [];
    const effectiveGateway = gatewayEvents;
    const gatewayOwned = parsedHost !== null;
    const terminalGateway = parsedHost?.complete === true;
    await writeFile(
      gatewayPath,
      gatewayEvents.map((event) => JSON.stringify(event)).join('\n') + (gatewayEvents.length === 0 ? '' : '\n'),
    );
    const events = parsedHost === null ? hostEvents : effectiveGateway;
    const terminalTrace = parsedHost === null ? hostTerminal : terminalGateway;
    const mcpCalls = mcp === null ? [] : await readMcpCalls(mcp.configPath);
    const taskChecks = await Promise.all(
      (item.checks ?? []).map((entry) =>
        check(entry, sandbox, exitCode, events, terminalTrace, timeoutSeconds, mcpCalls, capturedStdout, outputOverride, {
          CRAFT_EVAL_CASE_ID: item.id,
          CRAFT_EVAL_TRIAL: String(trial),
        }),
      ),
    );
    const safetyChecks = await Promise.all(
      (item.safety_checks ?? []).map((entry) =>
        check(entry, sandbox, exitCode, events, terminalTrace, timeoutSeconds, mcpCalls, capturedStdout, outputOverride, {
          CRAFT_EVAL_CASE_ID: item.id,
          CRAFT_EVAL_TRIAL: String(trial),
        }),
      ),
    );
    const trigger =
      item.skill === undefined || skill === null
        ? null
        : buildTrigger(
            item.skill,
            skill,
            hostEvents,
            effectiveGateway,
            hostTerminal,
            terminalGateway && (parsedHost === null || hostCanObserveSkill),
            gatewayOwned && hostCanObserveSkill,
          );
    const taskVerdict = verdictOf(taskChecks, item.threshold ?? 1);
    const safetyVerdict = verdictOf(safetyChecks);
    const verdict = decideVerdict(
      taskVerdict,
      safetyVerdict,
      safetyChecks,
      trigger,
      issue,
      subject.kind === 'agent' && item.prompt !== undefined,
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
      gateway_sha256: await sha256File(gatewayPath),
      trace_complete: terminalTrace,
      host: parsedHost?.observation ?? null,
    };
  } finally {
    // With --keep-traces, copy the raw capture files into the run directory before
    // the temp tree is removed, so failures can be diagnosed from the run output.
    if (keepTraces && runDir !== undefined) {
      const target = join(runDir, 'captures', `${item.id}-${trial}`);
      try {
        await mkdir(target, { recursive: true });
        for (const [name, source] of Object.entries(captures)) {
          try {
            await copyFile(source, join(target, name));
          } catch {
            // A capture file may be absent when the adapter never produced it.
          }
        }
        // Keep the sandbox output directory too: a failed case is usually
        // diagnosable only from the artifacts the checks actually inspected.
        if (artifactsDir !== null) {
          try {
            await cp(artifactsDir, join(target, 'outputs'), { recursive: true, force: true });
          } catch {
            // Outputs may be absent or partially written; capture is best-effort.
          }
        }
      } catch {
        // Capture export is best-effort; never mask the run result.
      }
    }
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

interface AdapterInput {
  argv: string[];
  stdin: string | null;
}

interface ParsedHost {
  events: TraceEvent[];
  complete: boolean;
  observation: HostObservation | null;
}

function hostArgv(config: HostConfig, sandbox: string, prompt: string): { argv: string[]; stdin: string | null } {
  const prefix = config.args_prefix ?? [];
  if (config.kind === 'codex') {
    const argv = [
      config.binary,
      ...prefix,
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      config.sandbox ?? 'read-only',
      '-C',
      sandbox,
    ];
    if (config.model !== undefined) {
      argv.push('--model', config.model);
    }
    argv.push('-');
    return { argv, stdin: prompt };
  }
  const argv = [
    config.binary,
    ...prefix,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
  ];
  if (config.model !== undefined) {
    argv.push('--model', config.model);
  }
  argv.push(prompt);
  return { argv, stdin: null };
}

function jsonLines(raw: Buffer): unknown[] | null {
  if (raw.length > MAX_TRACE_BYTES) {
    return null;
  }
  const values: unknown[] = [];
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return values;
}

function hasHostTerminal(values: unknown[], kind: HostConfig['kind']): boolean {
  return values.some((value) => record(value)?.type === (kind === 'codex' ? 'turn.completed' : 'result'));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenCount(usage: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (usage === null) {
    return null;
  }
  for (const key of keys) {
    const value = finiteNumber(usage[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function emptyObservation(config: HostConfig): HostObservation {
  return {
    adapter: config.kind,
    requested_model: config.model ?? null,
    observed_models: [],
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    cost_usd: null,
    tool_calls: 0,
  };
}

function parseHost(config: HostConfig, raw: Buffer, taskRunId: string): ParsedHost {
  const values = jsonLines(raw);
  if (values === null) {
    return { events: [], complete: false, observation: null };
  }
  if (!hasHostTerminal(values, config.kind)) {
    return { events: [], complete: false, observation: emptyObservation(config) };
  }
  return config.kind === 'codex'
    ? parseCodexHost(values, config, taskRunId)
    : parseClaudeHost(values, config, taskRunId);
}

function parseCodexHost(values: unknown[], config: HostConfig, taskRunId: string): ParsedHost {
  const observation = emptyObservation(config);
  const events: TraceEvent[] = [];
  let complete = false;
  for (const value of values) {
    const event = record(value);
    if (event === null) {
      continue;
    }
    if (event.type === 'item.completed') {
      const item = record(event.item);
      if (item?.type === 'command_execution') {
        observation.tool_calls += 1;
        events.push({ source: 'gateway', task_run_id: taskRunId, event: 'tool.called', tool: 'command' });
      } else if (item?.type === 'mcp_tool_call') {
        observation.tool_calls += 1;
        const tool = typeof item.tool === 'string' ? item.tool : 'mcp';
        events.push({ source: 'gateway', task_run_id: taskRunId, event: 'tool.called', tool });
      }
    } else if (event.type === 'turn.completed') {
      complete = true;
      const usage = record(event.usage);
      observation.input_tokens = tokenCount(usage, 'input_tokens');
      observation.cached_input_tokens = tokenCount(usage, 'cached_input_tokens');
      observation.output_tokens = tokenCount(usage, 'output_tokens');
      observation.reasoning_output_tokens = tokenCount(usage, 'reasoning_output_tokens');
      events.push({ source: 'gateway', task_run_id: taskRunId, event: 'run.finished' });
    }
  }
  return { events, complete, observation };
}

function parseClaudeHost(values: unknown[], config: HostConfig, taskRunId: string): ParsedHost {
  const observation = emptyObservation(config);
  const events: TraceEvent[] = [];
  const models = new Set<string>();
  let complete = false;
  let fallbackUsage: Record<string, unknown> | null = null;
  for (const value of values) {
    const event = record(value);
    if (event === null) {
      continue;
    }
    if (event.type === 'assistant') {
      const message = record(event.message);
      if (message !== null) {
        if (typeof message.model === 'string') {
          models.add(message.model);
        }
        const usage = record(message.usage);
        if (usage !== null) {
          fallbackUsage = usage;
        }
        if (Array.isArray(message.content)) {
          for (const content of message.content) {
            const block = record(content);
            if (block?.type !== 'tool_use') {
              continue;
            }
            observation.tool_calls += 1;
            const input = record(block.input);
            if (block.name === 'Skill' && input !== null && typeof input.skill === 'string') {
              events.push({
                source: 'gateway',
                task_run_id: taskRunId,
                event: 'skill.invoked',
                skill_id: input.skill,
              });
            }
            events.push({
              source: 'gateway',
              task_run_id: taskRunId,
              event: 'tool.called',
              tool: typeof block.name === 'string' ? block.name : 'unknown',
            });
          }
        }
      }
    } else if (event.type === 'result') {
      complete = true;
      observation.cost_usd = finiteNumber(event.total_cost_usd);
      const usage = record(event.usage) ?? fallbackUsage;
      observation.input_tokens = tokenCount(usage, 'input_tokens');
      observation.cached_input_tokens = tokenCount(usage, 'cache_read_input_tokens', 'cached_input_tokens');
      observation.output_tokens = tokenCount(usage, 'output_tokens');
      observation.reasoning_output_tokens = tokenCount(usage, 'reasoning_output_tokens');
      const modelUsage = record(event.modelUsage);
      if (modelUsage !== null) {
        for (const model of Object.keys(modelUsage)) {
          models.add(model);
        }
      }
      events.push({ source: 'gateway', task_run_id: taskRunId, event: 'run.finished' });
    }
  }
  observation.observed_models = [...models].sort();
  return { events, complete, observation };
}

function hostCapableOfSkillEvents(config: HostConfig): boolean {
  return config.kind === 'claude';
}

function runAdapter(
  item: Case,
  sandbox: string,
  env: Record<string, string>,
  stdoutPath: string,
  stderrPath: string,
  input?: AdapterInput,
): Promise<AdapterOutcome> {
  return new Promise((done) => {
    const argv = input?.argv ?? item.argv ?? [];
    let child: ChildProcess;
    try {
      child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd: sandbox,
        env,
        stdio: [input?.stdin === null || input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      done({
        exitCode: null,
        issue: `adapter_error:${(error as Error).name}`,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number | null, issue: string | null): void => {
      const mergedStdout = Buffer.concat(stdout);
      const mergedStderr = Buffer.concat(stderr);
      void writeCapture(stdoutPath, [mergedStdout], stderrPath, [mergedStderr]).then(() =>
        done({
          exitCode,
          issue,
          stdout: mergedStdout,
          stderr: mergedStderr,
        }),
      );
    };
    if (input?.stdin !== null && input !== undefined) {
      child.stdin?.end(input.stdin);
    }
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
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Fall through to a direct kill for minimal runtimes without taskkill.
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The adapter already exited; nothing left to kill.
  }
}

export interface RunOptions {
  trials?: number;
  /** Number of independent case/trial jobs run at once. In-place cases stay serial. */
  parallelism?: number;
  /**
   * `shared` copies the input workspace once and reuses it for every case.
   * This is only for a linear scenario where later steps depend on earlier
   * mutations; ordinary suites must keep the default isolated mode.
   */
  workspace_mode?: 'isolated' | 'shared';
  /** Stop after the first non-passing result. Requires shared workspace mode. */
  fail_fast?: boolean;
  /**
   * Snapshot the shared workspace after a passing case. Keys are case IDs and
   * values are output directories outside the input workspace.
   */
  workspace_snapshots?: Record<string, string>;
  /**
   * Initial shared workspace for a resumed scenario. The evaluator copies this
   * checkpoint instead of the original input workspace.
   */
  workspace_source?: string;
  /**
   * Keep per-case stdout, stderr and host/gateway traces under
   * `<run_dir>/captures/<case_id>-<trial>/` for debugging. By default these are
   * dropped after hashing so a run only carries evidence digests, not raw output.
   */
  keep_traces?: boolean;
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
  const parallelism = typeof options === 'number' ? 1 : (options.parallelism ?? 1);
  const workspaceMode = typeof options === 'number' ? 'isolated' : (options.workspace_mode ?? 'isolated');
  const failFast = typeof options === 'number' ? false : (options.fail_fast ?? false);
  const workspaceSnapshots = typeof options === 'number' ? {} : (options.workspace_snapshots ?? {});
  const workspaceSource = typeof options === 'number' ? undefined : options.workspace_source;
  const keepTraces = typeof options === 'number' ? false : (options.keep_traces ?? false);
  const suite = await loadSuite(suitePath);
  const subject = await loadSubject(subjectPath, suite.subject_kind);
  const runtime = await loadRuntime(runtimePath);
  for (const item of suite.cases) {
    if (subject.host === undefined && item.prompt !== undefined) {
      throw new Error(`case ${item.id} prompt requires subject.host`);
    }
  }
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) {
    throw new Error('trials must be 1..20');
  }
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 8) {
    throw new Error('parallelism must be 1..8');
  }
  if (workspaceMode !== 'isolated' && workspaceMode !== 'shared') {
    throw new Error('workspace_mode must be isolated or shared');
  }
  if (failFast && workspaceMode !== 'shared') {
    throw new Error('fail_fast requires shared workspace mode');
  }
  if (workspaceMode === 'shared' && trials !== 1) {
    throw new Error('shared workspace mode requires exactly one trial');
  }
  if (Object.keys(workspaceSnapshots).length > 0 && workspaceMode !== 'shared') {
    throw new Error('workspace_snapshots requires shared workspace mode');
  }
  if (workspaceSource !== undefined && workspaceMode !== 'shared') {
    throw new Error('workspace_source requires shared workspace mode');
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
  for (const [caseId, snapshot] of Object.entries(workspaceSnapshots)) {
    if (!suite.cases.some((item) => item.id === caseId)) {
      throw new Error(`workspace snapshot references unknown case: ${caseId}`);
    }
    const target = resolve(snapshot);
    if (target === workspacePath || target.startsWith(workspacePath + sep)) {
      throw new Error(`workspace snapshot for ${caseId} must be outside workspace`);
    }
  }
  if (workspaceSource !== undefined) {
    const source = resolve(workspaceSource);
    if (source === workspacePath || source.startsWith(workspacePath + sep)) {
      throw new Error('workspace source must be outside workspace');
    }
    const info = await stat(source).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error('workspace source must be a directory');
    }
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
  const jobs: Array<{ item: Case; workspace: string; trial: number }> = [];
  for (const item of suite.cases) {
    if (workspaceMode === 'shared' && item.workspace !== undefined) {
      throw new Error(`case ${item.id} cannot set workspace in shared workspace mode`);
    }
    // A case may name its own workspace, resolved under --workspace. Every
    // resolved directory must stay inside it, so a suite cannot reach out.
    const caseWorkspace =
      item.workspace === undefined ? workspacePath : resolve(workspacePath, item.workspace);
    if (caseWorkspace !== workspacePath && !caseWorkspace.startsWith(workspacePath + sep)) {
      throw new Error(`case ${item.id} workspace leaves --workspace`);
    }
    const caseWorkspaceInfo = await stat(caseWorkspace).catch(() => null);
    if (caseWorkspaceInfo === null || !caseWorkspaceInfo.isDirectory()) {
      throw new Error(`case ${item.id} workspace must be a directory`);
    }
    for (let trial = 1; trial <= trials; trial += 1) {
      jobs.push({ item, workspace: caseWorkspace, trial });
    }
  }
  const sharedRoot = workspaceMode === 'shared' ? await mkdtemp(join(tmpdir(), 'craft-eval-shared-')) : null;
  try {
    const sharedSandbox =
      sharedRoot === null ? undefined : join(sharedRoot, 'workspace');
    if (sharedSandbox !== undefined) {
      await workspaceCopy(workspaceSource === undefined ? workspacePath : resolve(workspaceSource), sharedSandbox);
    }
    const results = new Array<CaseResult>(jobs.length);
    let next = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped) {
          return;
        }
        const index = next;
        next += 1;
        const job = jobs[index];
        if (job === undefined) {
          return;
        }
        const result = await oneCase(job.item, subject, job.workspace, runId, job.trial, sharedSandbox, keepTraces, runDir);
        results[index] = result;
        await atomicJson(join(runDir, 'results', `${job.item.id}-${job.trial}.json`), result);
        const snapshot = workspaceSnapshots[job.item.id];
        if (snapshot !== undefined) {
          if (result.verdict !== 'passed') {
            stopped = true;
            return;
          }
          if (sharedSandbox === undefined) {
            throw new Error('workspace snapshot requires a shared sandbox');
          }
          const target = resolve(snapshot);
          await removeTree(target);
          await workspaceCopy(sharedSandbox, target);
        }
        if (failFast && result.verdict !== 'passed') {
          stopped = true;
          return;
        }
      }
    };
    const effective =
      workspaceMode === 'shared' || jobs.some((job) => job.item.in_place === true) ? 1 : parallelism;
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(effective, jobs.length) }, () => worker()),
    );
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failed !== undefined) {
      throw failed.reason;
    }
    if (!failFast && results.some((result) => result === undefined)) {
      throw new Error('run did not record every case');
    }
    return runDir;
  } finally {
    if (sharedRoot !== null) {
      await removeTree(sharedRoot);
    }
  }
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
    gateway_sha256: null,
    trace_complete: false,
    host: null,
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
  not_applicable?: number;
  by_language?: Record<
    string,
    { expected: number; passed: number; failed: number; not_applicable: number }
  >;
  status: 'complete' | 'incomplete';
  results: CaseResult[];
}

export async function reportRun(path: string): Promise<RunReport> {
  const { plan, results } = await loadRun(path);
  const count = (verdict: Verdict): number => results.filter((item) => item.verdict === verdict).length;
  const missing = count('missing');
  const inconclusive = count('inconclusive');
  const invalid = count('invalid');
  const notApplicable = count('not_applicable');
  const byLanguage: NonNullable<RunReport['by_language']> = {};
  for (const item of plan.suite.cases) {
    const language = item.language ?? 'unknown';
    const bucket = byLanguage[language] ?? { expected: 0, passed: 0, failed: 0, not_applicable: 0 };
    const caseResults = results.filter((result) => result.case_id === item.id);
    bucket.expected += caseResults.length;
    bucket.passed += caseResults.filter((result) => result.verdict === 'passed').length;
    bucket.failed += caseResults.filter((result) => result.verdict === 'failed').length;
    bucket.not_applicable += caseResults.filter((result) => result.verdict === 'not_applicable').length;
    byLanguage[language] = bucket;
  }
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
    not_applicable: notApplicable,
    by_language: byLanguage,
    status: missing === 0 && inconclusive === 0 && invalid === 0 ? 'complete' : 'incomplete',
    results,
  };
}

/**
 * Re-run only `script` checks against a prior run's captured outputs.
 *
 * This is the offline-regrade path: it needs a run produced with
 * `--keep-traces`, because the captured `outputs/` are what the script reads.
 * Other checks (notably `trace_event` and `tool_call`) keep their original
 * verdicts on purpose: gateway evidence is authoritative only in evaluator
 * memory, and reading a copy back from disk would let a subject forge it.
 */
export async function rescoreScripts(
  runDir: string,
  workspace: string,
  outputRoot: string,
): Promise<string> {
  const { plan, results } = await loadRun(runDir);
  const sourceRoot = resolve(runDir);
  const workspaceRoot = resolve(workspace);
  const info = await stat(workspaceRoot).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error('workspace must be a directory');
  }
  const output = resolve(outputRoot);
  await mkdir(output, { recursive: true });
  const runId = randomUUID().replace(/-/g, '');
  const nextDir = join(output, runId);
  await mkdir(join(nextDir, 'results'), { recursive: true });
  await atomicJson(join(nextDir, 'plan.json'), { ...plan, run_id: runId });

  const reuse = (checks: CheckResult[], entry: Check): CheckResult =>
    checks.find((item) => item.id === entry.id) ?? {
      id: entry.id,
      passed: null,
      reason: 'not_found',
      evidence: { kind: entry.kind },
    };

  for (const result of results) {
    const target = join(nextDir, 'results', `${result.case_id}-${result.trial}.json`);
    const caseDef = plan.suite.cases.find((item) => item.id === result.case_id);
    // Re-scoring must never turn a skipped (not_applicable) case into a verdict:
    // it has no captured outputs, so rerunning its script would fabricate a fail.
    if (result.verdict === 'missing' || result.verdict === 'not_applicable' || caseDef === undefined) {
      await atomicJson(target, result);
      continue;
    }
    const captured = join(sourceRoot, 'captures', `${result.case_id}-${result.trial}`);
    const sandbox = await mkdtemp(join(tmpdir(), 'craft-eval-rescore-'));
    try {
      await workspaceCopy(workspaceRoot, sandbox);
      const capturedOutputs = join(captured, 'outputs');
      if (existsSync(capturedOutputs)) {
        await mkdir(join(sandbox, 'outputs'), { recursive: true });
        await cp(capturedOutputs, join(sandbox, 'outputs'), { recursive: true, force: true });
      }
      const stdout = (await readFile(join(captured, 'stdout')).catch(() => Buffer.alloc(0))) as Buffer;
      const timeoutSeconds = caseDef.timeout_s ?? 30;
      const runScripts = (entries: Check[], previous: CheckResult[]): Promise<CheckResult[]> =>
        Promise.all(
          entries.map((entry) =>
            entry.kind === 'script'
              ? check(entry, sandbox, result.exit_code, [], result.trace_complete, timeoutSeconds, [], stdout, undefined, {
                  CRAFT_EVAL_CASE_ID: result.case_id,
                  CRAFT_EVAL_TRIAL: String(result.trial),
                })
              : Promise.resolve(reuse(previous, entry)),
          ),
        );
      const taskChecks = await runScripts(caseDef.checks ?? [], result.checks);
      const safetyChecks = await runScripts(caseDef.safety_checks ?? [], result.safety_checks);
      const taskVerdict = verdictOf(taskChecks);
      const safetyVerdict = verdictOf(safetyChecks);
      const requiresTrace = plan.subject.kind === 'agent' && caseDef.prompt !== undefined;
      await atomicJson(target, {
        ...result,
        verdict: decideVerdict(
          taskVerdict,
          safetyVerdict,
          safetyChecks,
          result.trigger,
          result.issue,
          requiresTrace,
          result.trace_complete,
        ),
        task_verdict: taskVerdict,
        safety_verdict: safetyChecks.length > 0 ? safetyVerdict : null,
        checks: taskChecks,
        safety_checks: safetyChecks,
      } satisfies CaseResult);
    } finally {
      await removeTree(sandbox);
    }
  }
  return nextDir;
}

export { signProbability } from './statistics.js';

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface MetricSummary {
  observed: number;
  mean: number | null;
  median: number | null;
  p95: number | null;
  variance: number | null;
  standard_deviation: number | null;
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
  primary_metric: string;
  primary_effect: ReturnType<typeof binaryEffect>;
  guardrails: Array<{
    id: string;
    status: 'passed' | 'failed' | 'not_evaluated';
    metric: string;
    observed: number | null;
    threshold: number;
    comparator: 'lte' | 'gte';
  }>;
  duration_ms: { baseline: MetricSummary; candidate: MetricSummary };
  cost_units: { baseline: MetricSummary; candidate: MetricSummary };
  duration_effect: ReturnType<typeof pairedContinuousEffect>;
  cost_effect: ReturnType<typeof pairedContinuousEffect>;
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
  const paired: BinaryPair[] = [];
  const durationPairs: ContinuousPair[] = [];
  const costPairs: ContinuousPair[] = [];
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
    } else {
      const baselinePassed = a.task_verdict === 'passed';
      const candidatePassed = b.task_verdict === 'passed';
      paired.push({ baseline: baselinePassed, candidate: candidatePassed });
      if (baselinePassed === candidatePassed) {
        ties += 1;
      } else if (candidatePassed) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
    if (isNumber(a.duration_ms) && isNumber(b.duration_ms)) {
      durationPairs.push({ baseline: a.duration_ms, candidate: b.duration_ms });
    }
    if (isNumber(a.cost_units) && isNumber(b.cost_units)) {
      costPairs.push({ baseline: a.cost_units, candidate: b.cost_units });
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
  const primaryEffect = binaryEffect(paired, 1);
  const probability = primaryEffect.sign_test_p;
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
  const metric = (items: CaseResult[], name: 'duration_ms' | 'cost_units'): MetricSummary => {
    const values = items.map((item) => item[name]).filter((value): value is number => isNumber(value));
    return summarizeContinuous(values);
  };
  const guardrails = (left.suite.metrics?.guardrails ?? []).map((guardrail) => {
    const values = candidate.results
      .map((item) => (guardrail.metric === 'duration_ms' ? item.duration_ms : guardrail.metric === 'cost_units' ? item.cost_units : null))
      .filter((value): value is number => isNumber(value));
    const observed = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
    const passed =
      observed === null
        ? 'not_evaluated'
        : guardrail.comparator === 'lte'
          ? observed <= guardrail.threshold
          : observed >= guardrail.threshold;
    return {
      id: guardrail.id,
      status: passed as 'passed' | 'failed' | 'not_evaluated',
      metric: guardrail.metric,
      observed,
      threshold: guardrail.threshold,
      comparator: guardrail.comparator,
    };
  });
  const guardrailFailure = guardrails.some((item) => item.status === 'failed');
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
    skill_gain_supported: gain && !guardrailFailure,
    primary_metric: left.suite.metrics?.primary.id ?? 'binary_pass_rate',
    primary_effect: primaryEffect,
    guardrails,
    duration_ms: { baseline: metric(baseline.results, 'duration_ms'), candidate: metric(candidate.results, 'duration_ms') },
    cost_units: { baseline: metric(baseline.results, 'cost_units'), candidate: metric(candidate.results, 'cost_units') },
    duration_effect: pairedContinuousEffect(durationPairs, 1),
    cost_effect: pairedContinuousEffect(costPairs, 1),
  };
}
