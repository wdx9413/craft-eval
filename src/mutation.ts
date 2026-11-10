/**
 * Mutation-driven sufficiency check.
 *
 * Given a baseline subject directory and defect-injection specs, apply each
 * mutation to a fresh copy of the subject, run the suite against it, and count
 * how many injected defects the suite catches. A surviving mutant is a suite
 * blind spot, not necessarily a product bug.
 */

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { reportRun, runSuite, type RunReport } from './evaluation.js';

export interface MutationSpec {
  id: string;
  file: string;
  find: string;
  replace: string;
  should_fail?: boolean;
}

export interface MutationReport {
  schema: 'craft-eval.mutation.v1';
  total: number;
  killed: number;
  survived: number;
  errored: number;
  mutation_score: number | null;
  mutants: Array<{
    id: string;
    status: 'killed' | 'survived' | 'error';
    expected: 'failed' | 'passed';
    observed: string | null;
    run_dir?: string;
    error?: string | null;
  }>;
}

interface MutationManifest {
  baseline_dir: string;
  /** Path to the subject definition; defaults to `<baseline_dir>/subject.json`. */
  subject_path?: string;
  /** Env vars overlaid onto the subject, with `{{copy}}` replaced by the mutated copy dir. */
  subject_env?: Record<string, string>;
  mutations: MutationSpec[];
}

async function loadManifest(path: string): Promise<MutationManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MutationManifest;
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.mutations)) {
    throw new Error('mutation manifest must contain a mutations array');
  }
  if (typeof raw.baseline_dir !== 'string' || raw.baseline_dir === '') {
    throw new Error('mutation manifest needs baseline_dir');
  }
  return raw;
}

function verdictOfReport(report: RunReport): 'passed' | 'failed' {
  return report.failed > 0 || report.inconclusive > 0 || report.invalid > 0 ? 'failed' : 'passed';
}

export async function runMutations(
  manifestPath: string,
  suitePath: string,
  runtimePath: string,
  workspace: string,
  outputRoot: string,
): Promise<MutationReport> {
  const manifest = await loadManifest(manifestPath);
  const manifestDir = resolve(manifestPath, '..');
  const baseline = resolve(manifestDir, manifest.baseline_dir);
  const output = resolve(outputRoot);
  await mkdir(output, { recursive: true });
  const mutants: MutationReport['mutants'] = [];
  for (const mutation of manifest.mutations) {
    const work = await mkdtemp(join(tmpdir(), 'craft-eval-mutant-'));
    try {
      const copy = join(work, 'subject');
      await cp(baseline, copy, { recursive: true });
      const target = join(copy, mutation.file);
      const source = await readFile(target, 'utf8');
      if (!source.includes(mutation.find)) {
        mutants.push({
          id: mutation.id,
          status: 'error',
          expected: mutation.should_fail === false ? 'passed' : 'failed',
          observed: null,
          error: `find-string not present in ${mutation.file}`,
        });
        continue;
      }
      await writeFile(target, source.replace(mutation.find, mutation.replace), 'utf8');
      // The mutated copy is also the workspace: suites whose cases run files
      // from the subject tree (the common in-repo pattern) then execute the
      // mutated code. Suites with their own fixtures keep passing `workspace`.
      const effectiveWorkspace = existsSync(join(copy, 'host.mjs')) ? copy : workspace;
      const subjectPath = manifest.subject_path === undefined
        ? join(copy, 'subject.json')
        : resolve(manifestDir, manifest.subject_path);
      const baseSubject = JSON.parse(await readFile(subjectPath, 'utf8')) as Record<string, unknown>;
      if (manifest.subject_env !== undefined) {
        const env = { ...((baseSubject.env as Record<string, string>) ?? {}) };
        for (const [key, value] of Object.entries(manifest.subject_env)) {
          env[key] = value.replaceAll('{{copy}}', copy);
        }
        baseSubject.env = env;
      }
      const subjectForRun = join(work, 'subject.json');
      await writeFile(subjectForRun, JSON.stringify(baseSubject), 'utf8');
      const run = await runSuite(suitePath, subjectForRun, runtimePath, effectiveWorkspace, join(output, mutation.id));
      const report = await reportRun(run);
      const observed = verdictOfReport(report);
      const expected = mutation.should_fail === false ? 'passed' : 'failed';
      mutants.push({
        id: mutation.id,
        status: observed === expected && expected === 'failed' ? 'killed' : 'survived',
        expected,
        observed,
        run_dir: run,
      });
    } catch (error) {
      mutants.push({
        id: mutation.id,
        status: 'error',
        expected: mutation.should_fail === false ? 'passed' : 'failed',
        observed: null,
        error: (error as Error).message,
      });
    } finally {
      await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
  const killed = mutants.filter((item) => item.status === 'killed').length;
  const survived = mutants.filter((item) => item.status === 'survived').length;
  const errored = mutants.filter((item) => item.status === 'error').length;
  const applicable = killed + survived;
  return {
    schema: 'craft-eval.mutation.v1',
    total: mutants.length,
    killed,
    survived,
    errored,
    mutation_score: applicable === 0 ? null : killed / applicable,
    mutants,
  };
}
