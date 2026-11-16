// Deterministic judge for the gated-output suites. Writes the verdict to
// stdout, which is the channel craft-eval reads for model_graded checks.
// The rubric is a tiny declarative rule so no model or credential is needed.
import { readFileSync } from 'node:fs';

const answerPath = process.env.CRAFT_EVAL_JUDGE_ANSWER;
if (!answerPath) {
  console.error(JSON.stringify({ score: 0, reason: 'missing CRAFT_EVAL_JUDGE_ANSWER' }));
  process.exit(1);
}

const answer = readFileSync(answerPath, 'utf8').trim().toLowerCase();
const rubric = process.env.CRAFT_EVAL_JUDGE_RUBRIC ?? '';

let score = 0;
let reason = 'no rule matched';
if (rubric.startsWith('eq:')) {
  const expected = rubric.slice(3).trim();
  const match = answer.match(/-?\d+(?:\.\d+)?/);
  score = match !== null && match[0] === expected ? 1 : 0;
  reason = `numeric ${match?.[0] ?? 'none'} vs expected ${expected}`;
} else if (rubric.startsWith('expect:')) {
  const expected = rubric.slice(7).trim().toLowerCase();
  score = answer.includes(expected) ? 1 : 0;
  reason = score === 1 ? `contains ${expected}` : `missing ${expected}`;
}

process.stdout.write(JSON.stringify({ score, reason }));
