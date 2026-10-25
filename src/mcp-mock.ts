/**
 * Evaluator-provided mock MCP server (stdio transport, zero dependencies).
 *
 * The suite declares tools with canned responses; this process serves them over
 * the standard MCP stdio transport so any real MCP client can connect. Every
 * accepted `tools/call` is appended synchronously to a log file chosen by the
 * evaluator, which is what makes `tool_call` checks grade from
 * evaluator-instrumented evidence instead of the subject's own claims.
 *
 * Launched as: node mcp-mock.js --server <name> --config <config.json>
 * The config file maps the server name to its log path and tool definitions,
 * because a subject may host several servers and env vars alone cannot carry
 * per-server state through one inherited environment.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const JSONRPC_VERSION = '2.0';
const PROTOCOL_VERSION = '2024-11-05';
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface MockResponse {
  content?: Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

interface MockTool {
  name: string;
  description?: string;
  input_schema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  response?: MockResponse;
}

interface MockServerConfig {
  name: string;
  log_path: string;
  tools: MockTool[];
}

interface ConfigFile {
  servers: MockServerConfig[];
}

function parseArgs(argv: string[]): { server: string; config: string } {
  let server: string | undefined;
  let config: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--server') {
      server = argv[index + 1];
      index += 1;
    } else if (token === '--config') {
      config = argv[index + 1];
      index += 1;
    }
  }
  if (server === undefined || config === undefined) {
    process.stderr.write('mcp-mock requires --server <name> --config <file>\n');
    process.exit(2);
  }
  return { server, config };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyResult(id: unknown, result: unknown): void {
  send({ jsonrpc: JSONRPC_VERSION, id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
}

const { server: serverName, config: configPath } = parseArgs(process.argv.slice(2));

let config: ConfigFile;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigFile;
} catch {
  process.stderr.write(`mcp-mock cannot read config: ${configPath}\n`);
  process.exit(2);
}

const found = config.servers.find((entry) => entry.name === serverName);
if (found === undefined) {
  process.stderr.write(`mcp-mock config has no server named ${serverName}\n`);
  process.exit(2);
}
const self: MockServerConfig = found;

function record(tool: string, args: unknown, delivered: boolean): void {
  const entry = {
    server: serverName,
    tool,
    arguments: args ?? null,
    delivered,
    task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID ?? null,
    case_id: process.env.CRAFT_EVAL_CASE_ID ?? null,
    at: new Date().toISOString(),
  };
  const logPath = self.log_path;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Evidence must never crash the transport; a failed write surfaces later
    // as a missing call in the check.
  }
}

const tools: MockTool[] = Array.isArray(self.tools) ? self.tools : [];

const readline = createInterface({ input: process.stdin, terminal: false });
readline.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  let message: { jsonrpc?: string; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown } };
  try {
    message = JSON.parse(line);
  } catch {
    replyError(null, PARSE_ERROR, 'parse error');
    return;
  }
  if (message.method === undefined) {
    // A response to something we never asked; ignore.
    return;
  }
  const method = String(message.method);
  const id = message.id;
  const isRequest = id !== undefined && id !== null;
  if (method === 'initialize') {
    const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : PROTOCOL_VERSION;
    replyResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false }, logging: {} },
      serverInfo: { name: serverName, version: '0.1.0' },
      instructions: `Mock MCP server ${serverName} provided by craft-eval for evaluation.`,
    });
    return;
  }
  if (method === 'notifications/initialized') {
    return;
  }
  if (method === 'ping') {
    if (isRequest) {
      replyResult(id, {});
    }
    return;
  }
  if (method === 'logging/setLevel') {
    if (isRequest) {
      replyResult(id, {});
    }
    return;
  }
  if (method === 'tools/list') {
    replyResult(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.input_schema ?? { type: 'object', properties: {} },
      })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof message.params?.name === 'string' ? message.params.name : '';
    const args = message.params?.arguments;
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) {
      record(name, args, false);
      // Per the MCP spec, an unknown tool is a protocol-level error so the
      // client can distinguish it from a tool that ran and failed.
      replyError(id, INVALID_PARAMS, `tool not found: ${name}`);
      return;
    }
    record(name, args, true);
    const response = tool.response ?? {};
    replyResult(id, {
      content: response.content ?? [{ type: 'text', text: 'ok' }],
      ...(response.is_error === true ? { isError: true } : {}),
    });
    return;
  }
  if (isRequest) {
    replyError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
});
readline.on('close', () => {
  process.exit(0);
});

// Absolute lifetime guard: the evaluator sizes this from the case timeout so a
// forgotten connection cannot keep the process alive past the run.
const lifetimeMs = Number(process.env.CRAFT_EVAL_MCP_MAX_LIFETIME_MS ?? 120_000);
setTimeout(() => process.exit(0), Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs : 120_000).unref();
