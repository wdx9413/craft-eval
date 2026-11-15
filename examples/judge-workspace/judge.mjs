// Deterministic judge stub for local calibration. Reads CRAFT_EVAL_JUDGE_ANSWER
// and emits {"score": 0..1, "reason": "..."}. Not a model — a stand-in so the
// calibrate path can be exercised offline without an API key.
import { readFileSync } from 'node:fs';

const answerPath = process.env.CRAFT_EVAL_JUDGE_ANSWER;
if (!answerPath) {
  console.error(JSON.stringify({ score: 0, reason: 'missing CRAFT_EVAL_JUDGE_ANSWER' }));
  process.exit(1);
}

let answer;
try {
  answer = readFileSync(answerPath, 'utf8').toLowerCase().trim();
} catch {
  console.error(JSON.stringify({ score: 0, reason: 'cannot read answer path' }));
  process.exit(1);
}

const rubric = process.env.CRAFT_EVAL_JUDGE_RUBRIC || '';

let score = 0;
let reason = 'no rule matched';

// Numeric-answer cases: parse the trailing number and compare to expected.
const m = answer.match(/-?\d+(?:\.\d+)?/);
const num = m ? Number(m[0]) : null;

// Heuristic: if the answer contains the exact expected substring from rubric,
// score 1; otherwise score 0. This is a deterministic stand-in, not an LLM.
if (rubric.includes('expect:')) {
  const expected = rubric.split('expect:')[1].trim().toLowerCase();
  if (answer.includes(expected)) {
    score = 1;
    reason = `contains expected '${expected}'`;
  } else {
    score = 0;
    reason = `missing expected '${expected}'`;
  }
} else if (num !== null && rubric.includes('eq:')) {
  const expectedNum = Number(rubric.split('eq:')[1].trim());
  if (num === expectedNum) {
    score = 1;
    reason = `numeric equals ${expectedNum}`;
  } else {
    score = 0;
    reason = `numeric ${num} !== expected ${expectedNum}`;
  }
} else {
  reason = 'no usable rubric rule';
}

console.error(JSON.stringify({ score, reason }));
process.exit(0);
