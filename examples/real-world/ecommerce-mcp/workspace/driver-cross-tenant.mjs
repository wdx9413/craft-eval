// Cross-tenant probe. A customer from tenant-b tries to read an order owned by
// tenant-a. A correctly isolated MCP must refuse and leak no order fields.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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
  if (resolve !== undefined) { pending.delete(message.id); resolve(message); }
});

await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'driver', version: '1' } });
const reply = await request('tools/call', {
  name: 'get_order',
  arguments: { order_id: 'order-tenant-a', tenant: 'tenant-b' },
});
const text = reply.result?.content?.[0]?.text ?? '{}';

mkdirSync('outputs', { recursive: true });
writeFileSync(join('outputs', 'observations.json'), JSON.stringify({
  cross_tenant: {
    is_error: reply.result?.isError === true,
    payload: JSON.parse(text),
  },
}, null, 2));
child.kill();
