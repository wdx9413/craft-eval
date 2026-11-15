/**
 * Judge calibration and consistency measurement.
 *
 * A model-graded judge is a measuring instrument: before trusting its verdicts,
 * score it against a gold set of known-answer samples and re-score the same
 * samples repeatedly to measure self-consistency. This produces a report; it
 * never mutates the judge or the suite.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBoundedCommand } from './bounded-command.js';

export interface GoldSample {
  id: string;
  /** Path (relative to the manifest) to the answer the judge must score. */
  answer: string;
  /** Known-correct verdict the judge should reach. */
  /** Known-correct verdict the judge should reach. */
  expected: 'passed' | 'failed';
  threshold?: number;
}

export interface CalibrationManifest {
  schema?: 'craft-eval.calibration.v1';
  /** Judge command; receives CRAFT_EVAL_JUDGE_ANSWER / _RUBRIC. */
  command: string[];
  rubric?: string;
  /** Working directory for the judge command. */
  dir?: string;
  /** Number of repeated scorings used to measure self-consistency. */
  repeats?: number;
  /** Optional gate: accuracy must reach this value (0..1). */
  minimum_accuracy?: number;
  /** Optional gate: self-consistency must reach this value (0..1). */
  minimum_consistency?: number;
  samples: GoldSample[];
}

interface SampleResult {
  id: string;
  expected: 'passed' | 'failed';
  scores: number[];
  verdicts: Array<'passed' | 'failed' | 'error'>;
  agreement: number | null;
  correct: boolean | null;
  error?: string | null;
}

export interface CalibrationReport {
  schema: 'craft-eval.calibration.v1';
  samples: number;
  accuracy: number | null;
  consistency: number | null;
  repeats: number;
  /**
   * Gate outcome. `true`/`false` only when every declared gate was measurable;
   * `null` means "no gate decision" — either no minimum was declared, or a
   * declared minimum could not be compared because the metric was unmeasured.
   */
  passed: boolean | null;
  /** The applied accuracy gate, absent when none was declared. */
  minimum_accuracy?: number;
  /** The applied consistency gate, absent when none was declared. */
  minimum_consistency?: number;
  per_sample: SampleResult[];
}

export interface CalibrationOptions {
  signal?: AbortSignal;
  /** Per scoring attempt; defaults to the existing 60 second timeout. */
  timeout_ms?: number;
  /** Combined stdout/stderr budget per attempt; defaults to 1 MiB. */
  max_output_bytes?: number;
}

type ScoreOutcome = { score: number; error: null } | { score: null; error: string };

function validateMinimum(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`calibration ${name} must be a number within 0..1`);
  }
  return value;
}

/**
 * Combine declared gates into one outcome. Each declared gate contributes
 * either a satisfied/unsatisfied vote or an "unmeasured" vote; any failing vote
 * wins, and unmeasured votes make the whole decision undecidable.
 */
function gateOutcome(
  accuracy: number | null,
  minimumAccuracy: number | undefined,
  consistency: number | null,
  minimumConsistency: number | undefined,
): boolean | null {
  if (minimumAccuracy === undefined && minimumConsistency === undefined) return null;
  const votes = [
    { minimum: minimumAccuracy, measured: accuracy },
    { minimum: minimumConsistency, measured: consistency },
  ];
  for (const { minimum, measured } of votes) {
    if (minimum === undefined) continue;
    if (measured === null) return null;
    if (measured < minimum) return false;
  }
  return true;
}

async function scoreOnce(
  manifest: CalibrationManifest,
  answerPath: string,
  options: CalibrationOptions,
): Promise<ScoreOutcome> {
  const env = {
    ...process.env,
    CRAFT_EVAL_JUDGE_ANSWER: answerPath,
    ...(manifest.rubric === undefined ? {} : { CRAFT_EVAL_JUDGE_RUBRIC: manifest.rubric }),
  } as Record<string, string>;
  const result = await runBoundedCommand(manifest.command[0]!, manifest.command.slice(1), {
    cwd: manifest.dir === undefined ? process.cwd() : resolve(manifest.dir),
    env,
    timeout_ms: options.timeout_ms ?? 60_000,
    max_output_bytes: options.max_output_bytes ?? 1024 * 1024,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  if (result.issue !== null) return { score: null, error: result.error?.name ?? result.issue };
  if (result.status !== 0) {
    return { score: null, error: `judge exited ${result.status}` };
  }
  try {
    const parsed = JSON.parse(result.stdout.toString('utf8')) as { score?: unknown };
    const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : null;
    if (score === null) {
      return { score: null, error: 'judge output has no numeric score' };
    }
    return { score, error: null };
  } catch {
    return { score: null, error: 'judge output is not JSON' };
  }
}

/**
 * Run the judge over a gold set. `accuracy` is agreement with known answers and
 * `consistency` is the share of samples whose repeated scorings agree.
 */
export async function calibrateJudge(manifestPath: string, options: CalibrationOptions = {}): Promise<CalibrationReport> {
  const control = Object.freeze({ ...options });
  control.signal?.throwIfAborted();
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CalibrationManifest;
  if (!Array.isArray(manifest.command) || manifest.command.length === 0 || typeof manifest.command[0] !== 'string' || manifest.command[0].length === 0 || !manifest.command.every(arg => typeof arg === 'string')) {
    throw new Error('calibration manifest requires a non-empty command array');
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    throw new Error('calibration manifest requires at least one gold sample');
  }
  const repeats = manifest.repeats ?? 3;
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('calibration repeats must be a positive safe integer');
  const minimumAccuracy = validateMinimum(manifest.minimum_accuracy, 'minimum_accuracy');
  const minimumConsistency = validateMinimum(manifest.minimum_consistency, 'minimum_consistency');
  const base = resolve(manifestPath, '..');
  // Resolve `dir` relative to the manifest so configs stay machine-independent.
  const resolved: CalibrationManifest = {
    ...manifest,
    ...(manifest.dir === undefined ? {} : { dir: resolve(base, manifest.dir) }),
  };
  const perSample: SampleResult[] = [];
  for (const sample of manifest.samples) {
    const answerPath = resolve(base, sample.answer);
    const threshold = sample.threshold ?? 0.5;
    const scores: number[] = [];
    const verdicts: SampleResult['verdicts'] = [];
    let error: string | null = null;
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      const outcome = await scoreOnce(resolved, answerPath, control);
      if (outcome.score === null) {
        error = outcome.error;
        verdicts.push('error');
        continue;
      }
      scores.push(outcome.score);
      verdicts.push(outcome.score >= threshold ? 'passed' : 'failed');
    }
    const decided = verdicts.filter((item) => item !== 'error') as Array<'passed' | 'failed'>;
    const agreement = decided.length === 0 ? null : decided.filter((item) => item === decided[0]).length / decided.length;
    perSample.push({
      id: sample.id,
      expected: sample.expected,
      scores,
      verdicts,
      agreement,
      // Correctness is judged from the majority verdict, never from one run.
      correct: decided.length === 0 ? null : (verdicts.filter((item) => item === sample.expected).length / decided.length) >= 0.5,
      error,
    });
  }
  const scored = perSample.filter((item) => item.correct !== null);
  const consistent = perSample.filter((item): item is SampleResult & { agreement: number } => item.agreement !== null);
  const accuracy = scored.length === 0 ? null : scored.filter((item) => item.correct === true).length / scored.length;
  const consistency =
    consistent.length === 0
      ? null
      : consistent.reduce((sum, item) => sum + item.agreement, 0) / consistent.length;
  const report: CalibrationReport = {
    schema: 'craft-eval.calibration.v1',
    samples: perSample.length,
    accuracy,
    consistency,
    repeats,
    passed: gateOutcome(accuracy, minimumAccuracy, consistency, minimumConsistency),
    per_sample: perSample,
  };
  if (minimumAccuracy !== undefined) report.minimum_accuracy = minimumAccuracy;
  if (minimumConsistency !== undefined) report.minimum_consistency = minimumConsistency;
  return report;
}
