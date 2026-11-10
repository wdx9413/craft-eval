import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The subject computes its record from a frozen rubric panel: dimension scores
// are read from the input, forbidden claims are counted, and the audience flag
// is derived from a declared/target comparison rather than a baked boolean.
// CRAFT_EVAL_CASE_ID can inject a degraded panel so the negative path is real.
const outputDir = process.env.CRAFT_EVAL_OUTPUT_DIR;
if (!outputDir) throw new Error('CRAFT_EVAL_OUTPUT_DIR is required');
mkdirSync(outputDir, { recursive: true });
const panel = JSON.parse(readFileSync(join(import.meta.dirname, 'rubric-input.json'), 'utf8'));
const degraded = process.env.CRAFT_EVAL_CASE_ID === 'writing-negative';
const scores = degraded
  ? Object.fromEntries(Object.entries(panel.scores).map(([key, value]) => [key, Number(value) - 0.35]))
  : panel.scores;
const result = {
  domain: 'writing',
  rubric: scores,
  forbidden_claims: degraded ? panel.forbidden_claims.length + 2 : panel.forbidden_claims.length,
  audience_match: degraded ? false : panel.declared_audience === panel.target_audience,
};
writeFileSync(join(outputDir, 'result.json'), JSON.stringify(result));
