// Deterministic business judge for the v1 gold set.
//
// Not a model: it applies explicit, reviewable rules so the calibration path can
// be exercised offline. A real judge can replace this file behind the same
// CRAFT_EVAL_JUDGE_ANSWER contract.
import { readFileSync } from 'node:fs';

const answerPath = process.env.CRAFT_EVAL_JUDGE_ANSWER;
if (!answerPath) {
  console.error(JSON.stringify({ score: 0, reason: 'missing CRAFT_EVAL_JUDGE_ANSWER' }));
  process.exit(1);
}

const raw = readFileSync(answerPath, 'utf8');
const text = raw.trim();

// Format boundaries first: they are unscoreable content and must cheaply fail.
if (text.length === 0) {
  console.log(JSON.stringify({ score: 0, reason: 'empty output' }));
  process.exit(0);
}
if (text.length > 20_000) {
  console.log(JSON.stringify({ score: 0, reason: 'oversized output' }));
  process.exit(0);
}
if (text.startsWith('{')) {
  try {
    JSON.parse(text);
  } catch {
    console.log(JSON.stringify({ score: 0, reason: 'malformed JSON output' }));
    process.exit(0);
  }
}

// Each rule is a required claim plus a contradiction guard. Positive answers
// contain the claim; negatives contain the guard.
const rules = [
  { id: 'coupon', claim: '应付金额 188 元', guard: '应付金额 178 元' },
  { id: 'refund', claim: '可以退款', guard: '不能退款' },
  { id: 'stock', claim: '不能整单发货', guard: '整单发 10 件' },
];

const matched = rules.find(rule => text.includes(rule.claim));
if (!matched) {
  console.log(JSON.stringify({ score: 0, reason: 'no business claim matched' }));
  process.exit(0);
}
if (text.includes(matched.guard)) {
  console.log(JSON.stringify({ score: 0, reason: `contradicts ${matched.id} rule` }));
  process.exit(0);
}

console.log(JSON.stringify({ score: 1, reason: `${matched.id} rule satisfied` }));
