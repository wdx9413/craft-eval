// Deterministic grader for the ecommerce-visual-copywriting skill cases.
// It reads the skill's own test-prompts.json rules and checks the model output
// against must_include groups and must_not_include phrases. No model judge.
import { readFileSync } from 'node:fs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const caseName = arg('case');
const answerPath = arg('answer', 'outputs/answer.md');
if (caseName === undefined) {
  console.error('missing --case');
  process.exit(2);
}

let prompts;
try {
  prompts = JSON.parse(readFileSync('test-prompts.json', 'utf8'));
} catch (error) {
  console.error(`cannot read test-prompts.json: ${error.message}`);
  process.exit(2);
}

const spec = prompts.find((item) => item.name === caseName);
if (spec === undefined) {
  console.error(`unknown case: ${caseName}`);
  process.exit(2);
}

let answer;
try {
  answer = readFileSync(answerPath, 'utf8');
} catch (error) {
  console.error(`cannot read answer ${answerPath}: ${error.message}`);
  process.exit(1);
}

const haystack = answer.toLowerCase();
const groups = (spec.must_include ?? []).map((entry) =>
  (Array.isArray(entry) ? entry : [entry]).map((value) => String(value).toLowerCase()),
);
const forbidden = (spec.must_not_include ?? []).map((value) => String(value).toLowerCase());

const missing = groups.filter((aliases) => !aliases.some((alias) => haystack.includes(alias)));

// The upstream skill's evaluator checks forbidden claims only in publishable
// copy, because a compliant plan legitimately quotes them in a risk ledger or
// lists them in a Negative Prompt. We approximate that boundary: a forbidden
// phrase counts only when it appears in a sentence without negation/avoidance
// markers. This avoids treating "must not claim 补肾" as a claim.
const NEGATION =
  /(不得|禁止|避免|勿|不要|不写|不可|不能|不做|不含|未提供|未核验|待补证|缺失|不虚构|兜底|avoid|without|omit|exclude|do\s*not|don't|negative\s*prompt|prohibit|forbid|not\s+)/i;
// Judge per line/paragraph instead of per clause: a markdown table row or a
// bullet often states "the requested claim → forbidden / not used" as one unit.
// Splitting on ；/。 severed the quoted term from its negation and caused false
// positives on the compliance ledger.
const sentences = answer
  .split(/\r?\n/)
  .map((part) => part.trim())
  .filter((part) => part !== '');
const hits = forbidden.filter((phrase) =>
  sentences.some((sentence) => sentence.toLowerCase().includes(phrase) && !NEGATION.test(sentence)),
);

if (missing.length > 0) {
  console.error(`missing required: ${missing.map((group) => group.join(' | ')).join(' ;; ')}`);
}
if (hits.length > 0) {
  console.error(`present but forbidden: ${hits.join(' ;; ')}`);
}
process.exit(missing.length === 0 && hits.length === 0 ? 0 : 1);
