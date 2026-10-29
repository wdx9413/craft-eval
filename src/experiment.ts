/**
 * Minimal experiment orchestration over Suite x Subject x Runtime x Trial.
 *
 * This is not a general DAG engine. It provides reproducible matrices, budget
 * limits, resume, and explicit retry records while delegating execution to
 * `runSuite`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { reportRun, runSuite } from './evaluation.js';

export interface ExperimentManifest {
  schema: 'craft-eval.experiment.v1';
  experiment_id: string;
  suites: string[];
  subjects: string[];
  runtimes: string[];
  trials: number;
  parallelism?: number;
  seed: number;
  budget?: {
    max_jobs?: number;
    max_cost_units?: number;
  };
  retry?: {
    max_attempts: number;
    only_verdicts?: Array<'failed' | 'inconclusive' | 'invalid' | 'missing'>;
  };
}

export interface ExperimentJob {
  id: string;
  suite: string;
  subject: string;
  runtime: string;
  trial: number;
  attempt: number;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  run_dir: string | null;
  error: string | null;
  /** Observed cost for this job, or null when no trustworthy value exists. */
  cost_units: number | null;
  /** False means at least one result in the run had no observable cost. */
  cost_observed: boolean;
}

export interface ExperimentReport {
  schema: 'craft-eval.experiment.v1';
  experiment_id: string;
  manifest_digest: string;
  status: 'complete' | 'partial' | 'budget_exhausted';
  jobs: ExperimentJob[];
  completed: number;
  failed: number;
  skipped: number;
  cost_units: number | null;
  cost_observed: boolean;
  budget_reason: 'max_jobs' | 'max_cost_units' | 'cost_unobserved' | null;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`${name} must be a non-empty array of at most 100 paths`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${name} entries must be non-empty strings`);
    }
    return item;
  });
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function loadExperiment(path: string): Promise<ExperimentManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('experiment manifest must be an object');
  }
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'craft-eval.experiment.v1') {
    throw new Error('experiment.schema must be craft-eval.experiment.v1');
  }
  const allowed = new Set([
    'schema',
    'experiment_id',
    'suites',
    'subjects',
    'runtimes',
    'trials',
    'parallelism',
    'seed',
    'budget',
    'retry',
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`experiment contains unsupported field: ${unknown}`);
  }
  if (typeof value.experiment_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.experiment_id)) {
    throw new Error('experiment_id must be a safe identifier');
  }
  const suites = stringList(value.suites, 'suites');
  const subjects = stringList(value.subjects, 'subjects');
  const runtimes = stringList(value.runtimes, 'runtimes');
  const trials = integer(value.trials, 'trials', 1, 20);
  const seed = integer(value.seed, 'seed', 0, 2 ** 31 - 1);
  const manifest: ExperimentManifest = {
    schema: 'craft-eval.experiment.v1',
    experiment_id: value.experiment_id,
    suites,
    subjects,
    runtimes,
    trials,
    seed,
  };
  if (value.parallelism !== undefined) {
    manifest.parallelism = integer(value.parallelism, 'parallelism', 1, 8);
  }
  if (value.budget !== undefined) {
    if (value.budget === null || typeof value.budget !== 'object' || Array.isArray(value.budget)) {
      throw new Error('budget must be an object');
    }
    const budget = value.budget as Record<string, unknown>;
    const allowedBudget = new Set(['max_jobs', 'max_cost_units']);
    const unknownBudget = Object.keys(budget).find((key) => !allowedBudget.has(key));
    if (unknownBudget !== undefined) {
      throw new Error(`budget contains unsupported field: ${unknownBudget}`);
    }
    manifest.budget = {};
    if (budget.max_jobs !== undefined) {
      manifest.budget.max_jobs = integer(budget.max_jobs, 'budget.max_jobs', 1, 10_000);
    }
    if (budget.max_cost_units !== undefined) {
      if (typeof budget.max_cost_units !== 'number' || !Number.isFinite(budget.max_cost_units) || budget.max_cost_units < 0) {
        throw new Error('budget.max_cost_units must be a non-negative number');
      }
      manifest.budget.max_cost_units = budget.max_cost_units;
    }
  }
  if (value.retry !== undefined) {
    if (value.retry === null || typeof value.retry !== 'object' || Array.isArray(value.retry)) {
      throw new Error('retry must be an object');
    }
    const retry = value.retry as Record<string, unknown>;
    const allowedRetry = new Set(['max_attempts', 'only_verdicts']);
    const unknownRetry = Object.keys(retry).find((key) => !allowedRetry.has(key));
    if (unknownRetry !== undefined) {
      throw new Error(`retry contains unsupported field: ${unknownRetry}`);
    }
    manifest.retry = {
      max_attempts: integer(retry.max_attempts, 'retry.max_attempts', 1, 5),
    };
    if (retry.only_verdicts !== undefined) {
      if (!Array.isArray(retry.only_verdicts) || retry.only_verdicts.length === 0) {
        throw new Error('retry.only_verdicts must be a non-empty array');
      }
      const verdicts = retry.only_verdicts.map((item) => {
        if (!['failed', 'inconclusive', 'invalid', 'missing'].includes(String(item))) {
          throw new Error('retry.only_verdicts contains an unsupported verdict');
        }
        return item as 'failed' | 'inconclusive' | 'invalid' | 'missing';
      });
      manifest.retry.only_verdicts = verdicts;
    }
  }
  return manifest;
}

function jobId(suite: string, subject: string, runtime: string, trial: number, attempt: number): string {
  return stableHash({ suite, subject, runtime, trial, attempt }).slice(0, 24);
}

export function experimentJobs(
  manifest: ExperimentManifest,
  resolvePath: (value: string) => string = (value) => value,
): ExperimentJob[] {
  const jobs: ExperimentJob[] = [];
  for (const suite of manifest.suites) {
    for (const subject of manifest.subjects) {
      for (const runtime of manifest.runtimes) {
        for (let trial = 1; trial <= manifest.trials; trial += 1) {
          const id = jobId(resolvePath(suite), resolvePath(subject), resolvePath(runtime), trial, 1);
          jobs.push({
            id,
            suite: resolvePath(suite),
            subject: resolvePath(subject),
            runtime: resolvePath(runtime),
            trial,
            attempt: 1,
            status: 'pending',
            run_dir: null,
            error: null,
            cost_units: null,
            cost_observed: false,
          });
        }
      }
    }
  }
  return jobs;
}

async function readIfExists(path: string): Promise<ExperimentReport | null> {
  try {
    const text = await readFile(path, 'utf8');
    const value = JSON.parse(text) as ExperimentReport;
    if (
      value.schema !== 'craft-eval.experiment.v1' ||
      !Array.isArray(value.jobs) ||
      typeof value.completed !== 'number' ||
      typeof value.failed !== 'number' ||
      typeof value.skipped !== 'number'
    ) {
      return null;
    }
    return {
      ...value,
      jobs: value.jobs.map((job) => ({
        ...job,
        cost_units: typeof job.cost_units === 'number' ? job.cost_units : null,
        cost_observed: job.cost_observed === true,
      })),
      cost_units: typeof value.cost_units === 'number' ? value.cost_units : null,
      cost_observed: value.cost_observed === true,
      budget_reason:
        value.budget_reason === 'max_jobs' ||
        value.budget_reason === 'max_cost_units' ||
        value.budget_reason === 'cost_unobserved'
          ? value.budget_reason
          : null,
    };
  } catch {
    return null;
  }
}

export interface ExperimentOptions {
  workspace: string;
  output: string;
  /** Optional injected runner for tests or an external scheduler. */
  run?: typeof runSuite;
}

interface ObservedRun {
  cost: number | null;
  observed: boolean;
}

async function observeRunCost(runDir: string): Promise<ObservedRun> {
  const report = await reportRun(runDir);
  if (report.results.length === 0) {
    return { cost: null, observed: false };
  }
  let total = 0;
  for (const item of report.results) {
    if (typeof item.cost_units !== 'number' || !Number.isFinite(item.cost_units)) {
      return { cost: null, observed: false };
    }
    total += item.cost_units;
  }
  return { cost: total, observed: true };
}

function writeReport(
  path: string,
  manifest: ExperimentManifest,
  manifestDigest: string,
  jobs: ExperimentJob[],
  completed: number,
  failed: number,
  skipped: number,
  cost: number | null,
  costObserved: boolean,
  budgetReason: ExperimentReport['budget_reason'],
): Promise<void> {
  const report: ExperimentReport = {
    schema: 'craft-eval.experiment.v1',
    experiment_id: manifest.experiment_id,
    manifest_digest: manifestDigest,
    status: budgetReason === null ? (failed > 0 ? 'partial' : 'complete') : 'budget_exhausted',
    jobs,
    completed,
    failed,
    skipped,
    cost_units: cost,
    cost_observed: costObserved,
    budget_reason: budgetReason,
  };
  return writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

export async function runExperiment(
  manifestPath: string,
  options: ExperimentOptions,
): Promise<ExperimentReport> {
  const manifest = await loadExperiment(manifestPath);
  const manifestDigest = stableHash(manifest);
  const root = resolve(options.output, manifest.experiment_id);
  await mkdir(root, { recursive: true });
  const reportPath = join(root, 'experiment.json');
  const previous = await readIfExists(reportPath);
  if (
    previous !== null &&
    typeof previous.manifest_digest === 'string' &&
    previous.manifest_digest !== manifestDigest
  ) {
    throw new Error('experiment manifest changed; use a new experiment_id or output directory');
  }
  const base = dirname(resolve(manifestPath));
  const resolvePath = (value: string): string => (isAbsolute(value) ? value : resolve(base, value));
  const baseJobs = experimentJobs(manifest, resolvePath);
  const previousBySlot = new Map<string, ExperimentJob[]>();
  for (const item of previous?.jobs ?? []) {
    const key = slotKey(item);
    const group = previousBySlot.get(key) ?? [];
    if (!group.some((existing) => existing.id === item.id)) {
      group.push({ ...item });
    }
    previousBySlot.set(key, group);
  }
  const jobs: ExperimentJob[] = [];
  const slots: ExperimentJob[][] = [];
  for (const baseJob of baseJobs) {
    const prior = previousBySlot.get(slotKey(baseJob)) ?? [];
    const attempts = prior.length === 0 ? [{ ...baseJob }] : prior;
    if (!attempts.some((item) => item.attempt === 1)) {
      attempts.unshift({ ...baseJob });
    }
    attempts.sort((left, right) => left.attempt - right.attempt);
    slots.push(attempts);
    jobs.push(...attempts);
  }
  const maxJobs = manifest.budget?.max_jobs ?? Number.POSITIVE_INFINITY;
  const maxCost = manifest.budget?.max_cost_units;
  let executed = jobs.filter((item) => item.status === 'completed' || item.status === 'failed').length;
  let spent = 0;
  let allCostObserved = true;
  for (const item of jobs) {
    if (item.status !== 'completed') {
      continue;
    }
    if (item.cost_observed && item.cost_units !== null) {
      spent += item.cost_units;
    } else {
      allCostObserved = false;
    }
  }
  let budgetReason: ExperimentReport['budget_reason'] = previous?.budget_reason ?? null;
  const runner = options.run ?? runSuite;
  const counts = (): { completed: number; failed: number; skipped: number } => ({
    completed: jobs.filter((item) => item.status === 'completed').length,
    failed: jobs.filter((item) => item.status === 'failed').length,
    skipped: jobs.filter((item) => item.status === 'skipped').length,
  });
  const persist = async (): Promise<void> => {
    const summary = counts();
    await writeReport(
      reportPath,
      manifest,
      manifestDigest,
      jobs,
      summary.completed,
      summary.failed,
      summary.skipped,
      allCostObserved ? spent : null,
      allCostObserved,
      budgetReason,
    );
  };
  const budgetAllowsAnother = (): boolean => {
    if (budgetReason !== null) {
      return false;
    }
    if (maxCost !== undefined && !allCostObserved) {
      budgetReason = 'cost_unobserved';
      return false;
    }
    if (maxCost !== undefined && spent >= maxCost) {
      budgetReason = 'max_cost_units';
      return false;
    }
    if (executed >= maxJobs) {
      budgetReason = 'max_jobs';
      return false;
    }
    return true;
  };
  const execute = async (job: ExperimentJob): Promise<void> => {
    executed += 1;
    try {
      const runDir = await runner(
        job.suite,
        job.subject,
        job.runtime,
        options.workspace,
        join(root, 'runs'),
        {
          trials: 1,
          parallelism: manifest.parallelism ?? 1,
        },
      );
      job.status = 'completed';
      job.run_dir = runDir;
      job.error = null;
      const observed = await observeRunCost(runDir);
      job.cost_units = observed.cost;
      job.cost_observed = observed.observed;
      if (!observed.observed) {
        allCostObserved = false;
        if (maxCost !== undefined) {
          budgetReason = 'cost_unobserved';
        }
      } else if (observed.cost !== null) {
        spent += observed.cost;
        if (maxCost !== undefined && spent > maxCost) {
          budgetReason = 'max_cost_units';
        }
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    }
    await persist();
  };
  const retryable = new Set(
    manifest.retry?.only_verdicts ?? ['failed', 'inconclusive', 'invalid', 'missing'],
  );
  const shouldRetry = async (job: ExperimentJob): Promise<boolean> => {
    if (manifest.retry === undefined || job.attempt >= manifest.retry.max_attempts) {
      return false;
    }
    if (job.status === 'failed') {
      return true;
    }
    if (job.status !== 'completed' || job.run_dir === null) {
      return false;
    }
    try {
      const report = await reportRun(job.run_dir);
      return report.results.some((item) => retryable.has(item.verdict));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.error = `retry_probe_failed:${message}`;
      return false;
    }
  };
  for (const attempts of slots) {
    for (;;) {
      const current = attempts[attempts.length - 1];
      if (current === undefined || current.status === 'skipped') {
        break;
      }
      if (current.status === 'pending') {
        if (!budgetAllowsAnother()) {
          break;
        }
        await execute(current);
        continue;
      }
      if (!(await shouldRetry(current))) {
        break;
      }
      if (!budgetAllowsAnother()) {
        break;
      }
      const next: ExperimentJob = {
        id: jobId(current.suite, current.subject, current.runtime, current.trial, current.attempt + 1),
        suite: current.suite,
        subject: current.subject,
        runtime: current.runtime,
        trial: current.trial,
        attempt: current.attempt + 1,
        status: 'pending',
        run_dir: null,
        error: null,
        cost_units: null,
        cost_observed: false,
      };
      jobs.push(next);
      attempts.push(next);
    }
  }
  if (budgetReason !== null) {
    for (const job of jobs) {
      if (job.status === 'pending') {
        job.status = 'skipped';
      }
    }
  }
  await persist();
  const summary = counts();
  return {
    schema: 'craft-eval.experiment.v1',
    experiment_id: manifest.experiment_id,
    manifest_digest: manifestDigest,
    status: budgetReason === null ? (summary.failed > 0 ? 'partial' : 'complete') : 'budget_exhausted',
    jobs,
    completed: summary.completed,
    failed: summary.failed,
    skipped: summary.skipped,
    cost_units: allCostObserved ? spent : null,
    cost_observed: allCostObserved,
    budget_reason: budgetReason,
  };
}

function slotKey(job: Pick<ExperimentJob, 'suite' | 'subject' | 'runtime' | 'trial'>): string {
  return JSON.stringify([job.suite, job.subject, job.runtime, job.trial]);
}
