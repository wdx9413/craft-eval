// MCP stdio client driver for the filesystem reference server.
// Connects to the subject server (descriptor via EVAL_SUBJECT_SERVER, set in subject.env),
// exercises tools, writes machine-checkable results into outputs/.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const serverCmd = JSON.parse(process.env.EVAL_SUBJECT_SERVER);
mkdirSync('outputs', { recursive: true });

const child = spawn(serverCmd.command, serverCmd.args, { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 1;
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
}
child.stdout.setEncoding('utf8');
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id).resolve(message);
    pending.delete(message.id);
  }
});
child.on('error', (error) => {
  writeFileSync('outputs/mcp-result.json', JSON.stringify({ connect_ok: false, error: String(error) }));
  process.exit(0);
});

const result = {
  connect_ok: false,
  init_ok: false,
  tools_listed: [],
  write_ok: false,
  read_back_ok: false,
  list_allowed_ok: false,
};

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'craft-eval-driver', version: '0.1.0' },
  });
  result.connect_ok = true;
  result.init_ok = Boolean(init.result?.serverInfo?.name);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await request('tools/list', {});
  result.tools_listed = (tools.result?.tools ?? []).map((t) => t.name).sort();

  const hasWrite = result.tools_listed.includes('write_file');
  const hasRead = result.tools_listed.includes('read_file');
  const hasList = result.tools_listed.includes('list_allowed_directories');

  if (hasList) {
    const listed = await request('tools/call', { name: 'list_allowed_directories', arguments: {} });
    result.list_allowed_ok = !listed.result?.isError;
  }
  if (hasWrite) {
    const written = await request('tools/call', {
      name: 'write_file',
      arguments: { path: 'probe.md', content: '# craft-eval probe\nwritten by driver\n' },
    });
    result.write_ok = !written.result?.isError;
  }
  if (hasRead) {
    const read = await request('tools/call', { name: 'read_file', arguments: { path: 'probe.md' } });
    const text = (read.result?.content ?? []).map((c) => c.text ?? '').join('');
    result.read_back_ok = text.includes('written by driver');
  }
} catch (error) {
  result.error = String(error);
}

writeFileSync('outputs/mcp-result.json', JSON.stringify(result, null, 2));
child.kill();
process.exit(0);
