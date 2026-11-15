// Drives the offline commerce MCP server through one scenario per case and
// writes the observed payloads for the grader. Nothing here grades.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const flagIndex = process.argv.indexOf('--case');
const caseId = flagIndex === -1 ? (process.env.CRAFT_EVAL_CASE_ID ?? '') : (process.argv[flagIndex + 1] ?? '');
const child = spawn(process.execPath, [join(process.cwd(), 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
}

createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const resolve = pending.get(message.id);
  if (resolve !== undefined) {
    pending.delete(message.id);
    resolve(message);
  }
});

async function call(name, args) {
  const reply = await request('tools/call', { name, arguments: args });
  const text = reply.result?.content?.[0]?.text ?? '{}';
  return { is_error: reply.result?.isError === true, payload: JSON.parse(text) };
}

await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'driver', version: '1' } });

const observations = {};
if (caseId === 'product-query') {
  observations.product = await call('get_product', { sku: 'sku-tea' });
} else if (caseId === 'coupon-threshold-199') {
  observations.quote = await call('quote_order', { sku: 'sku-tea', quantity: 1 });
} else if (caseId === 'coupon-threshold-200') {
  observations.quote = await call('quote_order', { sku: 'sku-tea', quantity: 2 });
} else if (caseId === 'coupon-threshold-201') {
  observations.quote = await call('quote_order', { sku: 'sku-tea', quantity: 3 });
} else if (caseId === 'order-create') {
  observations.order = await call('create_order', { sku: 'sku-tea', quantity: 1 });
} else if (caseId === 'order-out-of-stock') {
  observations.order = await call('create_order', { sku: 'sku-tea', quantity: 5 });
} else if (caseId === 'order-idempotent') {
  observations.first = await call('create_order', { sku: 'sku-tea', quantity: 1, idempotency_key: 'k1' });
  observations.second = await call('create_order', { sku: 'sku-tea', quantity: 1, idempotency_key: 'k1' });
}

mkdirSync('outputs', { recursive: true });
writeFileSync(join('outputs', 'observations.json'), JSON.stringify(observations, null, 2));
child.kill();
