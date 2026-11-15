import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CraftStore } from 'craft-common-store-local';
import { craftPaths } from 'craft-common-store-local/paths';

import { CraftServiceShim } from '../src/craft-service-shim.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'craft-shim-'));
  const store = await new CraftStore(craftPaths(join(root, 'data'))).open();
  return { root, store, service: new CraftServiceShim(store),
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('the shim persists real claims and relations so lineage sees them', async () => {
  const f = await fixture();
  try {
    const evidence = f.service.evidenceRecord({ evidence_id: 'ev', source_type: 'program', claim: 'fixture', confidence: 'confirmed' });
    assert.equal(evidence.id, 'ev');
    for (const id of ['base', 'derived']) {
      f.service.knowledgeClaimSave({ claim_id: id, kind: 'fact', content: `plain fixture ${id}`, scope: 'global', evidence_ids: ['ev'] });
    }
    const saved = f.service.relationSave({ relation_id: 'rel', source: { kind: 'knowledge_claim', id: 'derived' },
      target: { kind: 'knowledge_claim', id: 'base' }, relation: 'derives_from', confidence: 'bounded' });
    assert.equal(saved.idempotent, false);
    const impact = f.service.knowledgeLineageImpact({ node: { kind: 'knowledge_claim', id: 'base' } });
    assert.equal(impact.root_challenged, false);
    assert.equal((impact.impacted as unknown[]).length, 1);
    assert.equal(impact.needs_reevaluation, false);
  } finally { await f.close(); }
});

test('a live contradiction flags the root and its derived claims', async () => {
  const f = await fixture();
  try {
    f.service.evidenceRecord({ evidence_id: 'ev', source_type: 'program', claim: 'fixture', confidence: 'confirmed' });
    for (const id of ['base', 'derived', 'challenger']) {
      f.service.knowledgeClaimSave({ claim_id: id, kind: 'fact', content: `plain fixture ${id}`, scope: 'global', evidence_ids: ['ev'] });
    }
    f.service.relationSave({ relation_id: 'derives', source: { kind: 'knowledge_claim', id: 'derived' },
      target: { kind: 'knowledge_claim', id: 'base' }, relation: 'derives_from' });
    f.service.relationSave({ relation_id: 'contradicts', source: { kind: 'knowledge_claim', id: 'challenger' },
      target: { kind: 'knowledge_claim', id: 'base' }, relation: 'contradicts', confidence: 'confirmed', evidence_ids: ['ev'] });
    const impact = f.service.knowledgeLineageImpact({ node: { kind: 'knowledge_claim', id: 'base' } });
    assert.equal(impact.root_challenged, true);
    assert.equal(impact.needs_reevaluation, true);
    assert.deepEqual((impact.impacted as Array<{ needs_reevaluation: boolean }>).map((item) => item.needs_reevaluation), [true]);
  } finally { await f.close(); }
});

test('relations reject invalid shapes and unapproved workflow effects fail closed', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.relationSave({ source: { kind: 'knowledge_claim', id: 'a' },
      target: { kind: 'knowledge_claim', id: 'a' }, relation: 'derives_from' }), /must differ/u);
    assert.throws(() => f.service.relationSave({ source: { kind: 'knowledge_claim', id: 'a' },
      target: { kind: 'knowledge_claim', id: 'b' }, relation: 'made_up' }), /unsupported/u);
    const workflow = f.service.workflowSave({ name: 'gate', steps: [
      { id: 'one', type: 'assertion', evaluator: 'file_exists', path: 'present.txt', expected: true, side_effect: 'local_write' },
    ] });
    const project = join(f.root, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'present.txt'), 'hello');
    const refused = f.service.workflowRun({ workflow_id: workflow.id, project_root: project });
    assert.equal(refused.status, 'failed');
    assert.equal((refused.results as Array<{ error: string }>)[0]?.error, 'side_effect_not_approved');
    const allowed = f.service.workflowRun({ workflow_id: workflow.id, project_root: project, allow_execution: true });
    assert.equal(allowed.status, 'passed');
    assert.throws(() => f.service.workflowRun({ workflow_id: 'missing' }), /Unknown workflow/u);
  } finally { await f.close(); }
});
