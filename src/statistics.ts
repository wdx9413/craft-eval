/**
 * Deterministic statistics for paired evaluation results.
 *
 * The evaluator reports uncertainty alongside raw pair counts. It deliberately
 * does not collapse task, safety, latency and cost into one score.
 */

export interface BinaryPair {
  baseline: boolean;
  candidate: boolean;
}

export interface BinaryEffect {
  pairs: number;
  candidate_wins: number;
  baseline_wins: number;
  ties: number;
  risk_difference: number | null;
  risk_difference_ci95: [number, number] | null;
  odds_ratio: number | null;
  phi: number | null;
  sign_test_p: number | null;
}

export interface ContinuousSummary {
  observed: number;
  mean: number | null;
  median: number | null;
  p95: number | null;
  variance: number | null;
  standard_deviation: number | null;
}

export interface PairedContinuousEffect {
  pairs: number;
  mean_difference: number | null;
  median_difference: number | null;
  standardized_difference: number | null;
  bootstrap_mean_difference_ci95: [number, number] | null;
}

export interface ContinuousPair {
  baseline: number;
  candidate: number;
}

export function signProbability(wins: number, losses: number): number | null {
  const total = wins + losses;
  if (total === 0) {
    return null;
  }
  let probability = 0;
  for (let successes = wins; successes <= total; successes += 1) {
    probability += Math.exp(
      logGamma(total + 1) -
        logGamma(successes + 1) -
        logGamma(total - successes + 1) -
        total * Math.log(2),
    );
  }
  return Math.min(1, probability);
}

function logGamma(value: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
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

function quantile(sorted: number[], probability: number): number | null {
  if (sorted.length === 1) {
    return sorted[0] ?? null;
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

export function summarizeContinuous(values: number[]): ContinuousSummary {
  const observed = values.filter((item) => Number.isFinite(item));
  if (observed.length === 0) {
    return {
      observed: 0,
      mean: null,
      median: null,
      p95: null,
      variance: null,
      standard_deviation: null,
    };
  }
  const sorted = [...observed].sort((a, b) => a - b);
  const mean = observed.reduce((sum, value) => sum + value, 0) / observed.length;
  const variance =
    observed.length < 2
      ? null
      : observed.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (observed.length - 1);
  return {
    observed: observed.length,
    mean,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    variance,
    standard_deviation: variance === null ? null : Math.sqrt(variance),
  };
}

/** Deterministic PRNG so bootstrap intervals are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bootstrapMean(
  values: number[],
  seed: number,
  iterations: number,
): [number, number] | null {
  if (values.length < 2) {
    return null;
  }
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      const sample = values[Math.floor(random() * values.length)] as number;
      sum += sample;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const low = quantile(means, 0.025);
  const high = quantile(means, 0.975);
  return low === null || high === null ? null : [low, high];
}

export function binaryEffect(pairs: BinaryPair[], seed = 1): BinaryEffect {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const pair of pairs) {
    if (pair.baseline === pair.candidate) ties += 1;
    else if (pair.candidate) wins += 1;
    else losses += 1;
  }
  const n = pairs.length;
  const baselineRate = n === 0 ? null : pairs.filter((item) => item.baseline).length / n;
  const candidateRate = n === 0 ? null : pairs.filter((item) => item.candidate).length / n;
  const riskDifference =
    baselineRate === null || candidateRate === null ? null : candidateRate - baselineRate;
  const both = pairs.filter((item) => item.baseline && item.candidate).length;
  const neither = pairs.filter((item) => !item.baseline && !item.candidate).length;
  const oddsRatio = losses === 0 ? (wins === 0 ? null : Number.POSITIVE_INFINITY) : wins / losses;
  const denominator = Math.sqrt((both + wins) * (both + losses) * (neither + wins) * (neither + losses));
  const phi =
    denominator === 0 ? null : ((both * neither - wins * losses) / denominator);
  const differences = pairs.map((item) => (item.candidate ? 1 : 0) - (item.baseline ? 1 : 0));
  return {
    pairs: n,
    candidate_wins: wins,
    baseline_wins: losses,
    ties,
    risk_difference: riskDifference,
    risk_difference_ci95: bootstrapMean(differences, seed, 2_000),
    odds_ratio: oddsRatio,
    phi,
    sign_test_p: signProbability(wins, losses),
  };
}

export function pairedContinuousEffect(
  pairs: ContinuousPair[],
  seed = 1,
): PairedContinuousEffect {
  const differences = pairs
    .filter((item) => Number.isFinite(item.baseline) && Number.isFinite(item.candidate))
    .map((item) => item.candidate - item.baseline);
  if (differences.length === 0) {
    return {
      pairs: 0,
      mean_difference: null,
      median_difference: null,
      standardized_difference: null,
      bootstrap_mean_difference_ci95: null,
    };
  }
  const summary = summarizeContinuous(differences);
  const mean = summary.mean;
  const standardDeviation = summary.standard_deviation;
  return {
    pairs: differences.length,
    mean_difference: mean,
    median_difference: summary.median,
    standardized_difference:
      mean === null || standardDeviation === null || standardDeviation === 0
        ? null
        : mean / standardDeviation,
    bootstrap_mean_difference_ci95: bootstrapMean(differences, seed, 2_000),
  };
}
