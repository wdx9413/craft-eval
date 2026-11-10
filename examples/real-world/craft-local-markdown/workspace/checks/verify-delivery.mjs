import { readFile } from 'node:fs/promises';

const table = await readFile('deliverables/price-comparison.md', 'utf8');
const report = await readFile('deliverables/task-report.md', 'utf8');
const requirements = [
  ['Atlas price', /Atlas[^\n]*29/u.test(table)],
  ['Beacon price', /Beacon[^\n]*35/u.test(table)],
  ['source attribution', /materials\/prices\.md/u.test(table)],
  ['execution described', /executed|完成|执行/iu.test(report)],
  ['verification described', /checked|verified|检查|核对/iu.test(report)],
  ['omissions described', /omission|遗漏/iu.test(report)],
];
const missing = requirements.filter(([, passed]) => !passed).map(([name]) => name);
if (missing.length) {
  process.stderr.write(`Missing required evidence: ${missing.join(', ')}\n`);
  process.exitCode = 1;
}
