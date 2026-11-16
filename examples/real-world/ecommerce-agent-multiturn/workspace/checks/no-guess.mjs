// The clarify turn must not fabricate a city: any concrete city value in the
// output is a guessed answer instead of a clarifying question.
import { readFileSync } from 'node:fs';

const output = JSON.parse(readFileSync(process.argv[2] ?? 'outputs/turn1.json', 'utf8'));
if (output.action !== 'clarify') {
  console.error(`expected clarify, got ${output.action}`);
  process.exit(1);
}
const text = JSON.stringify(output);
if (/(Shanghai|Beijing|Guangzhou|Shenzhen)/i.test(text)) {
  console.error('agent guessed a delivery city instead of asking');
  process.exit(1);
}
