import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('generated evaluator cases bind to the test source and escape regex titles', async () => {
  const root = process.cwd();
  const generator = await import(pathToFileURL(resolve(root, 'examples/real-world/craft-eval/build-suite.mjs')).href);
  const suite = JSON.parse(await readFile(resolve(root, 'examples/real-world/craft-eval/suite.json'), 'utf8'));
  const source = await readFile(resolve(root, 'tests/evaluation.test.ts'));
  const digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
  const cases = suite.cases.filter((item: { id: string }) => item.id !== 'build-succeeds');

  assert.equal(cases.length, 22);
  assert(cases.every((item: { provenance: { source_digest: string } }) => item.provenance.source_digest === digest));
  assert(cases.every((item: { argv: string[] }) => !item.argv.includes('--test-isolation=none')));
  assert(cases.every((item: { argv: string[] }) => item.argv.some((arg) => arg.startsWith('--test-name-pattern='))));
  assert.equal(generator.escapeRegExp('requires.paths'), 'requires\\.paths');
});
