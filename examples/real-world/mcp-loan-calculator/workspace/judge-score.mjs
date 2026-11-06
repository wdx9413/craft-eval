// Score-style judge for the loan-calculator MCP: emits {"score": 0..1}.
// Used by `craft-eval calibrate` to measure the judge's gold-set accuracy.
import { readFileSync } from 'node:fs';

let result;
try {
  result = JSON.parse(readFileSync(process.env.CRAFT_EVAL_JUDGE_ANSWER, 'utf8'));
} catch (error) {
  console.log(JSON.stringify({ score: 0, reason: `unreadable answer: ${error.message}` }));
  process.exit(0);
}

// The monthly payment is a hard gate: an incorrect payment makes the whole
// answer wrong regardless of how well-formed the rest is. Averaging it with
// formatting checks let a $1.00 payment pass, which calibration caught.
const hardFail = !String(result.payment).includes('4890.17');
const softChecks = [
  result.init_ok === true,
  /Year 1: principal \$([0-9.,]+), interest \$([0-9.,]+)/.test(String(result.amort)),
];
const score = hardFail ? 0 : softChecks.filter(Boolean).length / softChecks.length;
console.log(
  JSON.stringify({
    score,
    reason: hardFail ? 'monthly payment is incorrect' : `${softChecks.filter(Boolean).length}/${softChecks.length} soft checks passed`,
  }),
);
