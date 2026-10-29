// Self-test for the negation-aware forbidden-claim matcher used by grade.mjs.
const NEGATION =
  /(不得|禁止|避免|勿|不要|不写|不可|不能|不做|不含|未提供|未核验|待补证|缺失|不虚构|兜底|avoid|without|omit|exclude|do\s*not|don't|negative\s*prompt|prohibit|forbid|not\s+)/i;
const forbidden = ['补肾', '乌发', '防脱发', '治疗', 'cures', 'detox', 'fda approved'];

function hits(answer) {
  const sentences = answer
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return forbidden.filter((phrase) =>
    sentences.some((sentence) => sentence.toLowerCase().includes(phrase) && !NEGATION.test(sentence)),
  );
}

const compliant =
  '证据账本\n待补证：无配料\n合规边界：不得写补肾、乌发、防脱发等功效\n' +
  '| 补肾、乌发（用户原始诉求） | 无；普通食品不得宣称 | 禁止 | 不进入最终稿 |\n' +
  'Negative Prompt: avoid cures, detox, FDA approved';
const violation = '证据账本\n待补证：无配料\n本品可以补肾乌发，治疗脱发。';

const compliantHits = hits(compliant);
const violationHits = hits(violation);
console.log('compliant hits:', JSON.stringify(compliantHits));
console.log('violation hits:', JSON.stringify(violationHits));
const ok = compliantHits.length === 0 && violationHits.length > 0;
console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
process.exit(ok ? 0 : 1);
