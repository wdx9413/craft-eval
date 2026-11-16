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
  expected: 'passed' | 'failed';
  threshold?: number;
  /**
   * What a correct answer looks like for this case. The same rubric grades
   * the known-good and the known-bad answer of one rule: the judge scores the
   * answer against the requirement, and the gold label says which side of it
   * the answer is on.
   */
  rubric?: string;
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
  /**
   * Gold set file, relative to this manifest. The gold set is the single
   * source of truth for samples and rubrics; two judges then read the same
   * set instead of each keeping a copy that can drift.
   */
  samples_file?: string;
  samples?: GoldSample[];
}

interface SampleResult {
  id: string;
  expected: 'passed' | 'failed';
  scores: number[];
  verdicts: Array<'passed' | 'failed' | 'error'>;
  agreement: number | null;
  correct: boolean | null;
  error?: string | null;
  /** Bounded judge diagnostics, so a failed scoring attempt can be diagnosed. */
  error_detail?: string | null;
}

export interface CalibrationReport {
  schema: 'craft-eval.calibration.v1';
  samples: number;
  accuracy: number | null;
  consistency: number | null;
  repeats: number;
  /** Scoring attempts that produced no verdict. */
  errors: number;
  /** Samples that produced at least one verdict. */
  measured_samples: number;
  /** Samples where every attempt failed; they are absent from every metric. */
  unmeasured_samples: number;
  /** Why a declared gate could not be decided, when that happened. */
  gate_undecided_reason?: string;
  /** True when the manifest declared at least one gate. */
  gate_declared: boolean;
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
 * wins, and unmeasured votes make the whole decision undecidable. A gold set
 * sample that never produced a verdict is also an unmeasured vote: a judge
 * that silently skipped a sample must not certify itself over the set.
 */
function gateOutcome(
  accuracy: number | null,
  minimumAccuracy: number | undefined,
  consistency: number | null,
  minimumConsistency: number | undefined,
  unmeasuredSamples: number,
): boolean | null {
  if (minimumAccuracy === undefined && minimumConsistency === undefined) return null;
  const votes = [
    { minimum: minimumAccuracy, measured: accuracy },
    { minimum: minimumConsistency, measured: consistency },
  ];
  for (const { minimum, measured } of votes) {
    if (minimum === undefined) continue;
    // A measured miss is a fail even when another metric is unmeasured: the
    // judge already proved it is wrong often enough.
    if (measured !== null && measured < minimum) return false;
  }
  if (votes.some(({ minimum, measured }) => minimum !== undefined && measured === null)) return null;
  if (unmeasuredSamples > 0) return null;
  return true;
}

async function scoreOnce(
  manifest: CalibrationManifest,
  answerPath: string,
  rubric: string | undefined,
  options: CalibrationOptions,
): Promise<{ score: number | null; error: string | null; detail: string | null }> {
  const env = {
    ...process.env,
    CRAFT_EVAL_JUDGE_ANSWER: answerPath,
    ...(rubric === undefined ? {} : { CRAFT_EVAL_JUDGE_RUBRIC: rubric }),
  } as Record<string, string>;
  const result = await runBoundedCommand(manifest.command[0]!, manifest.command.slice(1), {
    cwd: manifest.dir === undefined ? process.cwd() : resolve(manifest.dir),
    env,
    timeout_ms: options.timeout_ms ?? 60_000,
    max_output_bytes: options.max_output_bytes ?? 1024 * 1024,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const detail = result.stderr.toString('utf8').trim().slice(-500);
  if (result.issue !== null) {
    return { score: null, error: result.error?.name ?? result.issue, detail: detail === '' ? null : detail };
  }
  if (result.status !== 0) {
    return { score: null, error: `judge exited ${result.status}`, detail: detail === '' ? null : detail };
  }
  try {
    const parsed = JSON.parse(result.stdout.toString('utf8')) as { score?: unknown };
    const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : null;
    if (score === null) {
      return { score: null, error: 'judge output has no numeric score', detail: detail === '' ? null : detail };
    }
    return { score, error: null, detail: null };
  } catch {
    return { score: null, error: 'judge output is not JSON', detail: detail === '' ? null : detail };
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
  const repeats = manifest.repeats ?? 3;
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('calibration repeats must be a positive safe integer');
  const minimumAccuracy = validateMinimum(manifest.minimum_accuracy, 'minimum_accuracy');
  const minimumConsistency = validateMinimum(manifest.minimum_consistency, 'minimum_consistency');
  const base = resolve(manifestPath, '..');
  // The gold set can live in its own versioned file so several judges share
  // one set of samples and rubrics instead of each keeping a copy.
  let samples = manifest.samples;
  if (manifest.samples_file !== undefined) {
    if (typeof manifest.samples_file !== 'string' || manifest.samples_file === '') {
      throw new Error('calibration samples_file must be a non-empty path');
    }
    const goldSet = JSON.parse(await readFile(resolve(base, manifest.samples_file), 'utf8')) as { samples?: unknown };
    if (!Array.isArray(goldSet.samples)) {
      throw new Error('calibration samples_file must contain a samples array');
    }
    samples = goldSet.samples as GoldSample[];
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('calibration manifest requires at least one gold sample');
  }
  // Resolve `dir` relative to the manifest so configs stay machine-independent.
  const resolved: CalibrationManifest = {
    ...manifest,
    ...(manifest.dir === undefined ? {} : { dir: resolve(base, manifest.dir) }),
  };
  const perSample: SampleResult[] = [];
  for (const sample of samples) {
    const answerPath = resolve(base, sample.answer);
    const threshold = sample.threshold ?? 0.5;
    const scores: number[] = [];
    const verdicts: SampleResult['verdicts'] = [];
    let error: string | null = null;
    let errorDetail: string | null = null;
    // A sample rubric overrides the manifest default: one judge file can grade
    // several business rules, each with its own requirement.
    const rubric = sample.rubric ?? manifest.rubric;
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      const outcome = await scoreOnce(resolved, answerPath, rubric, control);
      if (outcome.score === null) {
        error = outcome.error;
        errorDetail = outcome.detail;
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
      error_detail: errorDetail,
    });
  }
  const scored = perSample.filter((item) => item.correct !== null);
  const consistent = perSample.filter((item): item is SampleResult & { agreement: number } => item.agreement !== null);
  const errors = perSample.reduce((total, item) => total + item.verdicts.filter((verdict) => verdict === 'error').length, 0);
  const unmeasuredSamples = perSample.filter((item) => item.correct === null).length;
  const accuracy = scored.length === 0 ? null : scored.filter((item) => item.correct === true).length / scored.length;
  const consistency =
    consistent.length === 0
      ? null
      : consistent.reduce((sum, item) => sum + item.agreement, 0) / consistent.length;
  const gateDeclared = minimumAccuracy !== undefined || minimumConsistency !== undefined;
  const passed = gateOutcome(accuracy, minimumAccuracy, consistency, minimumConsistency, unmeasuredSamples);
  const report: CalibrationReport = {
    schema: 'craft-eval.calibration.v1',
    samples: perSample.length,
    accuracy,
    consistency,
    repeats,
    errors,
    measured_samples: perSample.length - unmeasuredSamples,
    unmeasured_samples: unmeasuredSamples,
    gate_declared: gateDeclared,
    passed,
    per_sample: perSample,
  };
  if (gateDeclared && passed === null) {
    report.gate_undecided_reason = unmeasuredSamples > 0
      ? `${unmeasuredSamples} gold sample(s) produced no verdict; the judge could not be certified over the whole set`
      : 'a declared gate could not be measured';
  }
  if (minimumAccuracy !== undefined) report.minimum_accuracy = minimumAccuracy;
  if (minimumConsistency !== undefined) report.minimum_consistency = minimumConsistency;
  return report;
}
