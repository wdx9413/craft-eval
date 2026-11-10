// Generate a layered test suite for the craft checkout: every tests/*.test.ts
// is assigned to exactly one case, and cases run serially because craft's suite
// intentionally shares one process and mutates fetch/env globals.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const craftDir = resolve(process.argv[2] ?? join(here, '..', '..', '..', '..', 'craft'));
const testsDir = join(craftDir, 'tests');
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

if (files.length === 0) throw new Error(`no *.test.ts under ${testsDir}`);

const groupSize = Math.max(1, Number(process.argv[3] ?? 20));
// Files that call symlinkSync cannot run where Windows lacks developer mode.
// Group them separately and gate them with requires.symlink so the run reports
// not_applicable instead of a misleading failure.
const symlinkFiles = files.filter((name) => {
  const text = readFileSync(join(testsDir, name), 'utf8');
  return /symlinkSync\(|symlink\(/.test(text);
});
const plainFiles = files.filter((name) => !symlinkFiles.includes(name));
const cases = [];
const groups = [];
for (let index = 0; index < plainFiles.length; index += groupSize) {
  groups.push({ files: plainFiles.slice(index, index + groupSize), symlink: false });
}
for (let index = 0; index < symlinkFiles.length; index += groupSize) {
  groups.push({ files: symlinkFiles.slice(index, index + groupSize), symlink: true });
}
for (const [groupIndex, group] of groups.entries()) {
  const chunk = group.files.map((name) => `tests/${name}`);
  cases.push({
    id: `tests-${String(groupIndex + 1).padStart(2, '0')}`,
    category: 'tests',
    risk: 'high',
    language: 'typescript',
    ...(group.symlink ? { requires: { symlink: true } } : {}),
    argv: ['node', '--test', '--test-isolation=none', '--test-concurrency=1', ...chunk],
    in_place: true,
    timeout_s: 900,
    checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }],
  });
}

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'craft-project-tests',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  claim: {
    statement: 'craft 的全部 TypeScript 单元/集成测试可通过',
    scope: `tests/ 下 ${files.length} 个测试文件，分 ${cases.length} 组串行执行；${symlinkFiles.length} 个依赖 symlink 的文件已单独分组`,
    limitations: ['串行执行；单组超时 900s；无 symlink 权限的环境会跳过需要 symlink 的组'],
  },
  metrics: {
    primary: { id: 'task_pass', kind: 'binary_pass_rate', direction: 'higher_is_better', minimum_sample: cases.length },
  },
  cases,
};

const output = join(here, 'suite-tests.json');
writeFileSync(output, JSON.stringify(suite, null, 2), 'utf8');
console.log(`wrote ${output}: ${files.length} files in ${cases.length} cases`);
