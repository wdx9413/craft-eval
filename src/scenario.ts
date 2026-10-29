/**
 * Linear scenarios for long-running tasks.
 *
 * A scenario is a sequence of prompt/command steps with checkpoints. Recovery is
 * explicit: resume starts from the last completed checkpoint and records every
 * attempt. This intentionally does not model arbitrary graphs.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  reportRun,
  runSuite,
  type Case,
  type Check,
  type CaseResult,
  type RunOptions,
} from './evaluation.js';

export interface ScenarioStep {
  id: string;
  prompt?: string;
  argv?: string[];
  timeout_s?: number;
  checks?: Check[];
  safety_checks?: Check[];
}

export interface ScenarioCheckpoint {
  id: string;
  after_step: string;
  checks?: Check[];
}

export interface Scenario {
  schema: 'craft-eval.scenario.v1';
  scenario_id: string;
  steps: ScenarioStep[];
  checkpoints?: ScenarioCheckpoint[];
  final_checks: Check[];
  recovery?: {
    on_interruption: 'resume' | 'fail';
  };
}

export interface ScenarioAttempt {
  step_id: string;
  attempt: number;
  status: 'passed' | 'failed' | 'interrupted' | 'skipped';
  issue: string | null;
}

export interface ScenarioReport {
  schema: 'craft-eval.scenario.v1';
  scenario_id: string;
  run_id: string;
  status: 'passed' | 'failed' | 'partial';
  completed_step: string | null;
  attempts: ScenarioAttempt[];
  failed_step: string | null;
  failed_check: string | null;
  results: CaseResult[];
}

export interface ScenarioRunOptions {
  subject: string;
  runtime: string;
  workspace: string;
  output: string;
  resumeAfter?: string;
  /** Optional injected runner for tests or an external scheduler. */
  run?: typeof runSuite;
}

export interface ScenarioRunResult {
  run_dir: string;
  report_path: string;
  report: ScenarioReport;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${name} must be a safe identifier`);
  }
  return value;
}

function checkList(value: unknown, name: string): Check[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
    return item as Check;
  });
}

export async function loadScenario(path: string): Promise<Scenario> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('scenario must be an object');
  }
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'craft-eval.scenario.v1') {
    throw new Error('scenario.schema must be craft-eval.scenario.v1');
  }
  const allowed = new Set(['schema', 'scenario_id', 'steps', 'checkpoints', 'final_checks', 'recovery']);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`scenario contains unsupported field: ${unknown}`);
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 100) {
    throw new Error('scenario.steps must contain 1..100 steps');
  }
  const steps: ScenarioStep[] = value.steps.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`scenario.steps[${index}] must be an object`);
    }
    const step = item as Record<string, unknown>;
    const allowedStep = new Set(['id', 'prompt', 'argv', 'timeout_s', 'checks', 'safety_checks']);
    const unknownStep = Object.keys(step).find((key) => !allowedStep.has(key));
    if (unknownStep !== undefined) {
      throw new Error(`scenario.steps[${index}] contains unsupported field: ${unknownStep}`);
    }
    if (step.prompt !== undefined && step.argv !== undefined) {
      throw new Error(`scenario.steps[${index}] cannot set both prompt and argv`);
    }
    if (step.prompt === undefined && step.argv === undefined) {
      throw new Error(`scenario.steps[${index}] needs prompt or argv`);
    }
    if (step.prompt !== undefined && (typeof step.prompt !== 'string' || step.prompt.trim() === '')) {
      throw new Error(`scenario.steps[${index}].prompt must be a non-empty string`);
    }
    if (step.argv !== undefined) {
      if (!Array.isArray(step.argv) || step.argv.length === 0 || step.argv.some((arg) => typeof arg !== 'string' || arg === '')) {
        throw new Error(`scenario.steps[${index}].argv must be non-empty strings`);
      }
    }
    if (step.timeout_s !== undefined) {
      if (
        typeof step.timeout_s !== 'number' ||
        !Number.isFinite(step.timeout_s) ||
        step.timeout_s <= 0 ||
        step.timeout_s > 3_600
      ) {
        throw new Error(`scenario.steps[${index}].timeout_s must be within 0..3600`);
      }
    }
    return {
      id: identifier(step.id, `scenario.steps[${index}].id`),
      ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
      ...(step.argv === undefined ? {} : { argv: step.argv as string[] }),
      ...(step.timeout_s === undefined ? {} : { timeout_s: step.timeout_s as number }),
      ...(step.checks === undefined ? {} : { checks: checkList(step.checks, `scenario.steps[${index}].checks`) }),
      ...(step.safety_checks === undefined
        ? {}
        : { safety_checks: checkList(step.safety_checks, `scenario.steps[${index}].safety_checks`) }),
    };
  });
  const ids = steps.map((item) => item.id);
  if (ids.length !== new Set(ids).size) {
    throw new Error('scenario step IDs must be unique');
  }
  const finalChecks = checkList(value.final_checks ?? [], 'scenario.final_checks');
  if (finalChecks.length === 0) {
    throw new Error('scenario needs final_checks');
  }
  const checkpoints: ScenarioCheckpoint[] = [];
  if (value.checkpoints !== undefined) {
    if (!Array.isArray(value.checkpoints) || value.checkpoints.length > 100) {
      throw new Error('scenario.checkpoints must be an array');
    }
    for (const [index, item] of value.checkpoints.entries()) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`scenario.checkpoints[${index}] must be an object`);
      }
      const checkpoint = item as Record<string, unknown>;
      const allowedCheckpoint = new Set(['id', 'after_step', 'checks']);
      const unknownCheckpoint = Object.keys(checkpoint).find((key) => !allowedCheckpoint.has(key));
      if (unknownCheckpoint !== undefined) {
        throw new Error(`scenario.checkpoints[${index}] contains unsupported field: ${unknownCheckpoint}`);
      }
      const id = identifier(checkpoint.id, `scenario.checkpoints[${index}].id`);
      const after = identifier(checkpoint.after_step, `scenario.checkpoints[${index}].after_step`);
      if (!ids.includes(after)) {
        throw new Error(`scenario checkpoint ${id} references unknown step`);
      }
      checkpoints.push({
        id,
        after_step: after,
        ...(checkpoint.checks === undefined
          ? {}
          : { checks: checkList(checkpoint.checks, `scenario.checkpoints[${index}].checks`) }),
      });
    }
  }
  if (new Set(checkpoints.map((item) => item.id)).size !== checkpoints.length) {
    throw new Error('scenario checkpoint IDs must be unique');
  }
  if (value.recovery !== undefined) {
    if (value.recovery === null || typeof value.recovery !== 'object' || Array.isArray(value.recovery)) {
      throw new Error('scenario.recovery must be an object');
    }
    const recovery = value.recovery as Record<string, unknown>;
    const allowedRecovery = new Set(['on_interruption']);
    const unknownRecovery = Object.keys(recovery).find((key) => !allowedRecovery.has(key));
    if (unknownRecovery !== undefined) {
      throw new Error(`scenario.recovery contains unsupported field: ${unknownRecovery}`);
    }
    if (recovery.on_interruption !== 'resume' && recovery.on_interruption !== 'fail') {
      throw new Error('scenario.recovery.on_interruption must be resume or fail');
    }
  }
  return {
    schema: 'craft-eval.scenario.v1',
    scenario_id: identifier(value.scenario_id, 'scenario_id'),
    steps,
    checkpoints,
    final_checks: finalChecks,
    ...(value.recovery === undefined
      ? {}
      : { recovery: value.recovery as Scenario['recovery'] }),
  };
}

/**
 * Convert a scenario into ordinary cases for the existing executor.
 *
 * Each case carries a step prefix and can be resumed by filtering out steps
 * before the checkpoint. This keeps execution evidence in the same format.
 */
export function scenarioCases(
  scenario: Scenario,
  options: { resumeAfter?: string; trials?: number } = {},
): Case[] {
  const resumeIndex =
    options.resumeAfter === undefined
      ? -1
      : scenario.steps.findIndex((step) => step.id === options.resumeAfter);
  if (options.resumeAfter !== undefined && resumeIndex < 0) {
    throw new Error('resumeAfter must name a scenario step');
  }
  const selected = scenario.steps.slice(resumeIndex + 1);
  if (selected.length === 0) {
    throw new Error('scenario has no steps after the resume checkpoint');
  }
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) {
    throw new Error('scenario trials must be 1..20');
  }
  const cases: Case[] = [];
  for (const [index, step] of selected.entries()) {
    const stepChecks = [...(step.checks ?? [])];
    for (const checkpoint of scenario.checkpoints ?? []) {
      if (checkpoint.after_step === step.id) {
        stepChecks.push(...(checkpoint.checks ?? []));
      }
    }
    const isLast = index === selected.length - 1;
    const checks = isLast ? [...stepChecks, ...scenario.final_checks] : stepChecks;
    const base: Case = {
      id: `${scenario.scenario_id}.${step.id}`,
      timeout_s: step.timeout_s ?? 30,
      checks,
      safety_checks: step.safety_checks ?? [],
    };
    if (step.prompt !== undefined) {
      base.prompt = step.prompt;
    } else if (step.argv !== undefined) {
      base.argv = step.argv;
    }
    cases.push(base);
  }
  return cases;
}

export async function writeScenarioReport(root: string, report: ScenarioReport): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, 'scenario-report.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return path;
}

export function scenarioReport(
  scenario: Scenario,
  runId: string,
  results: CaseResult[],
  selectedStepIds?: string[],
): ScenarioReport {
  const effectiveSteps = selectedStepIds ?? scenario.steps.map((step) => step.id);
  const stepId = (caseId: string): string =>
    caseId.startsWith(`${scenario.scenario_id}.`)
      ? caseId.slice(scenario.scenario_id.length + 1)
      : caseId;
  const recorded = new Set(results.map((item) => stepId(item.case_id)));
  const pending = selectedStepIds === undefined ? [] : effectiveSteps.filter((id) => !recorded.has(id));
  const attempts: ScenarioAttempt[] = [
    ...results.map((item) => ({
      step_id: stepId(item.case_id),
      attempt: item.trial,
      status:
        item.verdict === 'passed'
          ? ('passed' as const)
          : item.verdict === 'missing'
            ? ('skipped' as const)
            : item.verdict === 'inconclusive' || item.verdict === 'invalid'
            ? ('interrupted' as const)
            : ('failed' as const),
      issue: item.issue,
    })),
    ...pending
      .map((id) => ({
        step_id: id,
        attempt: 1,
        status: 'skipped' as const,
        issue: null,
      })),
  ];
  const observed = results.filter((item) => item.verdict !== 'missing');
  const failed = observed.find((item) => item.verdict !== 'passed');
  const failedCheck =
    failed === undefined
      ? null
      : (failed.safety_checks.find((item) => item.passed === false) ??
          failed.checks.find((item) => item.passed === false))?.id ?? null;
  const completed = [...observed].reverse().find((item) => item.verdict === 'passed');
  const completedStep = completed === undefined ? null : stepId(completed.case_id);
  const finalSelected = effectiveSteps[effectiveSteps.length - 1];
  const isComplete = completedStep !== null && completedStep === finalSelected;
  const firstCompletedIndex =
    completedStep === null ? -1 : effectiveSteps.indexOf(completedStep);
  const skipped = attempts.some(
    (item) =>
      !isComplete &&
      item.status === 'skipped' &&
      effectiveSteps.indexOf(item.step_id) > firstCompletedIndex,
  );
  return {
    schema: 'craft-eval.scenario.v1',
    scenario_id: scenario.scenario_id,
    run_id: runId,
    status: failed !== undefined ? 'failed' : skipped || results.length === 0 ? 'partial' : 'passed',
    completed_step: completedStep,
    attempts,
    failed_step: failed === undefined ? null : stepId(failed.case_id),
    failed_check: failedCheck,
    results,
  };
}

export async function runScenario(
  scenario: Scenario,
  options: ScenarioRunOptions,
): Promise<ScenarioRunResult> {
  const selectedCases = scenarioCases(scenario, { resumeAfter: options.resumeAfter }).map((item) => ({
    ...item,
    ...((item.checks ?? []).length === 0
      ? { checks: [{ id: `step_exit_${item.id.slice(scenario.scenario_id.length + 1)}`, kind: 'exit_code' as const, equals: 0 }] }
      : {}),
  }));
  const selectedStepIds = selectedCases.map((item) => item.id.slice(scenario.scenario_id.length + 1));
  const output = resolve(options.output);
  const suitePath = join(output, `${scenario.scenario_id}.suite.json`);
  await mkdir(output, { recursive: true });
  await writeFile(
    suitePath,
    JSON.stringify({
      schema: 'craft-eval.eval.v1',
      suite_id: `${scenario.scenario_id}-scenario`,
      subject_kind: 'agent',
      partition: 'development',
      sanitized: true,
      cases: selectedCases,
    }) + '\n',
    'utf8',
  );
  const checkpointRoot = join(output, 'checkpoints', scenario.scenario_id);
  const workspaceSnapshots = Object.fromEntries(
    selectedStepIds.map((stepId) => [
      `${scenario.scenario_id}.${stepId}`,
      join(checkpointRoot, stepId),
    ]),
  );
  let workspaceSource: string | undefined;
  if (options.resumeAfter !== undefined) {
    if (scenario.recovery?.on_interruption !== 'resume') {
      throw new Error('--resume-after requires scenario.recovery.on_interruption=resume');
    }
    workspaceSource = join(checkpointRoot, options.resumeAfter);
    const info = await stat(workspaceSource).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(`no checkpoint workspace found for step: ${options.resumeAfter}`);
    }
  }
  const runOptions: RunOptions = {
    trials: 1,
    parallelism: 1,
    workspace_mode: 'shared',
    fail_fast: true,
    workspace_snapshots: workspaceSnapshots,
    ...(workspaceSource === undefined ? {} : { workspace_source: workspaceSource }),
  };
  const runner = options.run ?? runSuite;
  const runDir = await runner(
    suitePath,
    options.subject,
    options.runtime,
    options.workspace,
    join(output, 'runs'),
    runOptions,
  );
  const runReport = await reportRun(runDir);
  const report = scenarioReport(scenario, runReport.run_id, runReport.results, selectedStepIds);
  const reportPath = await writeScenarioReport(output, report);
  return { run_dir: runDir, report_path: reportPath, report };
}
