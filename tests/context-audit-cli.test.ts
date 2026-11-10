import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('context-audit CLI returns a machine-readable pass or failure and rejects malformed invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-context-audit-'));
  const packPath = join(root, 'pack.json'), manifestPath = join(root, 'expectations.json');
  const cli = resolve('dist/src/cli.js');
  try {
    await writeFile(packPath, JSON.stringify({ asset_refs: [{ member: 'knowledge', id: 'claim-a' }], pack_receipt: { max_items: 2, max_chars: 40, total_items: 1, total_used_chars: 20, partial: false } }));
    await writeFile(manifestPath, JSON.stringify({ schema: 'craft-eval.context-audit.v1', case_id: 'one', required_refs: [{ member: 'knowledge', id: 'claim-a' }] }));
    const passed = spawnSync(process.execPath, [cli, 'context-audit', packPath, manifestPath], { encoding: 'utf8' });
    assert.equal(passed.status, 0); assert.equal(JSON.parse(passed.stdout).status, 'passed');
    await writeFile(packPath, JSON.stringify({ asset_refs: [{ member: 'knowledge', id: 'claim-a' }],
      pack_receipt: { max_items: 2, max_chars: 40, total_items: 1, total_used_chars: 20, partial: false },
      response_partial: true, response_omitted_items: 2, response_omission_reason: 'response_token_budget' }));
    const partial = spawnSync(process.execPath, [cli, 'context-audit', packPath, manifestPath], { encoding: 'utf8' });
    assert.equal(partial.status, 1); assert.equal(JSON.parse(partial.stdout).status, 'inconclusive');
    assert.equal(JSON.parse(partial.stdout).metrics.response_omitted_items, 2);
    await writeFile(packPath, JSON.stringify({ asset_refs: [{ member: 'knowledge', id: 'claim-a' }], pack_receipt: { max_items: 2, max_chars: 40, total_items: 1, total_used_chars: 20, partial: false } }));
    await writeFile(manifestPath, JSON.stringify({ schema: 'craft-eval.context-audit.v1', case_id: 'one', required_refs: [{ member: 'knowledge', id: 'missing' }] }));
    const failed = spawnSync(process.execPath, [cli, 'context-audit', packPath, manifestPath], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).status, 'failed');
    const missing = spawnSync(process.execPath, [cli, 'context-audit', packPath], { encoding: 'utf8' });
    assert.equal(missing.status, 2); assert.match(JSON.parse(missing.stderr).error, /missing arguments/u);
    await writeFile(packPath, '{');
    const malformed = spawnSync(process.execPath, [cli, 'context-audit', packPath, manifestPath], { encoding: 'utf8' });
    assert.equal(malformed.status, 2); assert.match(JSON.parse(malformed.stderr).error, /JSON/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
