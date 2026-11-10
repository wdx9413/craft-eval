import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const model = JSON.parse(await readFile('model-setup.json', 'utf8'));
const state = JSON.parse(await readFile('state.json', 'utf8'));
const document = await readFile('deliverables/comparison.md', 'utf8');
assert.equal(model.configured, true);
assert.equal(model.key, '[REDACTED]');
assert.match(document, /page-north/u);
assert.match(document, /page-south/u);
assert.match(document, /page-west/u);
assert.match(document, /User edit: South has higher priority/u);
assert.equal(state.resumed, true);
assert.deepEqual(state.preferences, [{ id: 'price-order', value: 'ascending', status: 'revoked' }]);
