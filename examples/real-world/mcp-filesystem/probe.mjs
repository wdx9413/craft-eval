process.on('uncaughtException', (e) => { try { mkdirSync('outputs', { recursive: true }); writeFileSync('outputs/crash.txt', String(e && e.stack || e)); } catch {} process.exit(1); });
// Generic MCP stdio probe driver.
//
// Reads probe.json (an array of probe steps) from the case workspace, connects to
// the subject server, executes every step, and writes outputs/probe-result.json
// with one record per step. The suite then grades each record with json_equals,
// so a failing step names exactly what broke instead of "the case failed".
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const descriptor = JSON.parse(process.env.EVAL_SUBJECT_SERVER);
const steps = JSON.parse(readFileSync('probe.json', 'utf8'));
mkdirSync('outputs', { recursive: true });

const child = spawn(descriptor.command, descriptor.args, {
  cwd: process.cwd(),
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

child.stdout.setEncoding('utf8');
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

/** Flatten an MCP tool result into comparable text plus its error flag. */
function summarize(response) {
  const result = response?.result;
  if (result === undefined) {
    return { ok: false, is_error: true, text: '', rpc_error: response?.error?.message ?? 'no result' };
  }
  const text = (result.content ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
  return { ok: true, is_error: result.isError === true, text };
}

const records = {};
try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'craft-eval-probe', version: '0.1.0' },
  });
  records.__init = { ok: Boolean(init.result?.serverInfo?.name), name: init.result?.serverInfo?.name ?? null };
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listed = await request('tools/list', {});
  records.__tools = (listed.result?.tools ?? []).map((tool) => tool.name).sort();

  for (const step of steps) {
    const response = await request('tools/call', { name: step.tool, arguments: step.arguments ?? {} });
    const summary = summarize(response);
    records[step.id] = {
      tool: step.tool,
      is_error: summary.is_error,
      text: summary.text.slice(0, 4000),
      rpc_error: summary.rpc_error ?? null,
    };
  }
} catch (error) {
  records.__error = String(error);
}

writeFileSync('outputs/probe-result.json', JSON.stringify(records, null, 2));
child.kill();
process.exit(0);
