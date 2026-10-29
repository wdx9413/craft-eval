// MCP stdio client: spawns the real subject server (outside this workspace) and
// exercises its finance tools. The subject checkout is never modified.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.EVAL_SUBJECT_DIR;
if (!dir) {
  console.error('missing EVAL_SUBJECT_DIR');
  process.exit(2);
}

const child = spawn(process.execPath, [join(dir, 'src/index.js')], {
  cwd: dir,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 1;
function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
}
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
child.on('error', (error) => {
  mkdirSync('outputs', { recursive: true });
  writeFileSync('outputs/result.json', JSON.stringify({ init_ok: false, error: String(error) }));
  process.exit(0);
});

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'craft-eval-driver', version: '0.1.0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// Cases differ by an explicit --rate argument (not by case id), so each case's
// content digest is distinct and the input is self-describing.
const rateIndex = process.argv.indexOf('--rate');
const annualRate = rateIndex === -1 ? 4.2 : Number(process.argv[rateIndex + 1]);
const loan = { principal: 1000000, annual_rate: annualRate, years: 30 };
const pay = await request('tools/call', { name: 'loan_payment', arguments: loan });
const amort = await request('tools/call', { name: 'loan_amortize', arguments: loan });

mkdirSync('outputs', { recursive: true });
writeFileSync(
  'outputs/result.json',
  JSON.stringify(
    {
      init_ok: Boolean(init.result?.serverInfo?.name),
      annual_rate: annualRate,
      payment: pay.result?.content?.[0]?.text ?? '',
      amort: amort.result?.content?.[0]?.text ?? '',
    },
    null,
    2,
  ),
);
child.kill();
