import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { startHttpMocks } from '../src/http-mock.js';
import { probeLoopback } from '../src/loopback.js';
import {
  buildChatRequest,
  createFetchTransport,
  credentialStatus,
  defineProvider,
  parseChatResponse,
  priceModelUsage,
  providerFromConfig,
  publicModel,
  publicProvider,
  selectModel,
  specFromConfig,
  specsFromModels,
  unconfiguredTransport,
  PROVIDER_CATALOG,
} from '../src/model-gateway.js';
import {
  defaultSettings,
  isOnboardingComplete,
  loadSettings,
  loadSettingsSync,
  markOnboardingComplete,
  normalizeSettings,
  publicSettings,
  resetOnboarding,
  resetSettings,
  resetSettingsSync,
  saveSettings,
  saveSettingsSync,
} from '../src/settings.js';
import { craftPaths } from 'craft-common-store-local';

const MCP_MOCK = fileURLToPath(new URL('../src/mcp-mock.js', import.meta.url));

async function fixture(): Promise<{ root: string; paths: ReturnType<typeof craftPaths> }> {
  const root = await mkdtemp(join(tmpdir(), 'craft-fixture-'));
  return { root, paths: craftPaths(root) };
}

test('http mock servers answer declared routes and record every call', async () => {
  const f = await fixture();
  try {
    const running = await startHttpMocks([
      {
        env: 'FIXTURE_API',
        routes: [
          { path: '/items', method: 'GET', body: { ok: true } },
          { path: '/items', method: 'POST', status: 201, headers: { 'x-fixture': 'yes' }, body: 'created' },
        ],
      },
    ]);
    const base = running.environment.FIXTURE_API!;
    const listed = await fetch(`${base}/items`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { ok: true });
    const created = await fetch(`${base}/items`, { method: 'POST', body: '{"a":1}' });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x-fixture'), 'yes');
    assert.equal(await created.text(), 'created');
    const missing = await fetch(`${base}/absent`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'no_route', method: 'GET', path: '/absent' });
    assert.equal(running.calls.length, 3);
    assert.equal(running.calls[2]?.path, '/absent');
    await running.stop();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the loopback probe reports a usable binding', async () => {
  assert.equal(await probeLoopback(), true);
  const failing = await probeLoopback(() => ({
    once: (_event: string, listener: (error: Error) => void) => { listener(new Error('refused')); },
    listen: () => undefined,
    close: () => undefined,
  }) as never);
  assert.equal(failing, false);
});

test('provider declarations validate names, tiers, urls and pricing', () => {
  const provider = defineProvider({
    provider: 'local', protocol: 'openai-compatible', base_url: 'http://127.0.0.1:8000/v1/',
    api_key_env: 'LOCAL_KEY', models: { small: 's', standard: 'm', frontier: 'f' },
  });
  assert.equal(provider.base_url, 'http://127.0.0.1:8000/v1');
  assert.equal(provider.chat_path, '/chat/completions');
  assert.equal(provider.label, 'local');
  assert.equal(provider.cost_hint, 1);
  assert.equal(provider.supports_tools, true);
  assert.equal(provider.context_cache?.mode, 'none');
  assert.throws(() => defineProvider({ provider: 'Bad Name', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's' } }), /provider name/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'other', base_url: 'http://x', api_key_env: 'K', models: { small: 's' } }), /protocol/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'lower', models: { small: 's' } }), /api_key_env/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: {} }), /model tier/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's' }, supports_tools: 'yes' }), /supports_tools/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's' }, cost_hint: -1 }), /cost_hint/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'not-a-url', api_key_env: 'K', models: { small: 's' } }), /valid HTTP/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://u:p@x', api_key_env: 'K', models: { small: 's' } }), /without credentials/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's' }, pricing: [] }), /pricing/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's' }, pricing: { other: { version: 'v', input_usd_per_million: 1, output_usd_per_million: 1 } } }), /configured model/);
  assert.throws(() => defineProvider({ provider: 'ok', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's' }, context_cache: { mode: 'other' } }), /context_cache/);
  const cached = defineProvider({
    provider: 'deepseek', protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1',
    api_key_env: 'DEEPSEEK_API_KEY', models: { small: 's' },
  });
  assert.equal(cached.context_cache?.mode, 'automatic_prefix');
  assert.equal(cached.context_cache?.usage_fields, 'deepseek');
  const anthropic = defineProvider({ provider: 'claude', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key_env: 'ANTHROPIC_API_KEY', models: { standard: 'm' } });
  assert.equal(anthropic.chat_path, '/messages');
  assert.equal(PROVIDER_CATALOG.length > 0, true);
});

test('model selection degrades downwards and never invents a tier', () => {
  const spec = defineProvider({ provider: 'local', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { small: 's', standard: 'm' } });
  assert.deepEqual(selectModel(spec, 'standard'), { tier: 'standard', model: 'm', downgraded: false });
  assert.deepEqual(selectModel(spec, 'frontier'), { tier: 'standard', model: 'm', downgraded: true });
  assert.deepEqual(selectModel(spec, 'small'), { tier: 'small', model: 's', downgraded: false });
  assert.throws(() => selectModel(spec, 'huge' as never), /tier/);
  const empty = { ...spec, models: {} as Record<string, string> };
  assert.throws(() => selectModel(empty as never, 'frontier'), /no usable model/);
});

test('public views never disclose the credential value', () => {
  const model = {
    id: 'local', name: 'Local', protocol: 'openai-compatible' as const, baseUrl: 'http://x',
    model: 'm', apiKeyEnv: 'LOCAL_KEY', supportsTools: true,
  };
  const view = publicModel(model, { LOCAL_KEY: 'secret-value' });
  assert.equal(view.configured, true);
  assert.ok(!JSON.stringify(view).includes('secret-value'));
  assert.equal(publicModel(model, {}).configured, false);
  const spec = specFromConfig(model);
  assert.equal(spec.provider, 'local');
  assert.equal(specsFromModels([model]).length, 1);
  const provider = publicProvider(spec, { LOCAL_KEY: 'secret-value' });
  assert.equal(provider.configured, true);
  assert.ok(!JSON.stringify(provider).includes('secret-value'));
  assert.equal(publicProvider(spec, {}).configured, false);
  const hostManaged = publicProvider({ ...spec, host_managed_auth: true }, {});
  assert.equal(hostManaged.configured, true);
  assert.equal(hostManaged.api_key_env, 'host-managed-auth-store');
  assert.equal(credentialStatus(spec, { LOCAL_KEY: 'x' }).configured, true);
  assert.equal(credentialStatus(spec, {}).configured, false);
  assert.equal(credentialStatus({ ...spec, host_managed_auth: true }, {}).configured, true);
  const legacy = providerFromConfig({ protocol: 'openai-compatible', name: 'My Model', baseUrl: 'http://x', model: 'm' });
  assert.equal(legacy.provider, 'my-model');
  assert.equal(legacy.api_key_env, 'CRAFT_API_KEY');
});

test('pricing only applies to configured models with observable usage', () => {
  const spec = defineProvider({
    provider: 'local', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K',
    models: { standard: 'm' },
    pricing: { m: { version: 'v1', input_usd_per_million: 2, output_usd_per_million: 4 } },
  });
  const priced = priceModelUsage(spec, 'm', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(priced?.cost_usd, 6);
  assert.equal(priced?.rounding, 'ceil_micro_usd');
  assert.equal(priceModelUsage(spec, 'other', { input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(priceModelUsage(spec, 'm', null), null);
  assert.throws(() => priceModelUsage(spec, 'm', { input_tokens: -1, output_tokens: 1 }), /non-negative/);
  assert.throws(() => priceModelUsage(spec, 'm', { input_tokens: 1, output_tokens: 1, cache_hit_tokens: 5 }), /exceed input/);
  const cachedSpec = defineProvider({
    provider: 'local', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K',
    models: { standard: 'm' },
    pricing: { m: { version: 'v1', input_usd_per_million: 2, output_usd_per_million: 4, cached_input_usd_per_million: 1 } },
  });
  assert.equal(priceModelUsage(cachedSpec, 'm', { input_tokens: 10, output_tokens: 1, cache_hit_tokens: 5 })?.cost_usd, 0.000019);
});

test('chat requests are rendered for both wire formats without leaking secrets', () => {
  const spec = defineProvider({
    provider: 'local', protocol: 'openai-compatible', base_url: 'http://127.0.0.1:8000/v1',
    api_key_env: 'LOCAL_KEY', models: { standard: 'm' },
  });
  const request = buildChatRequest(spec, {
    model: 'm', messages: [{ role: 'user', content: 'token=abc' }], max_tokens: 100, temperature: 0,
  });
  assert.equal(request.url, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(request.headers.authorization, 'env:LOCAL_KEY');
  assert.ok(!JSON.stringify(request.body).includes('abc'));
  assert.ok(request.prompt_tokens_estimate >= 1);
  assert.equal(request.context_cache.eligible, false);
  const anthropic = defineProvider({
    provider: 'claude', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1',
    api_key_env: 'ANTHROPIC_API_KEY', models: { standard: 'm' },
  });
  const claude = buildChatRequest(anthropic, {
    model: 'm', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { token: { type: 'string' } } } } }],
  });
  assert.equal(claude.headers['anthropic-version'], '2023-06-01');
  assert.equal((claude.body.system as string).length > 0, true);
  assert.throws(() => buildChatRequest(spec, { model: '', messages: [{ role: 'user', content: 'x' }] }), /model/);
  assert.throws(() => buildChatRequest(spec, { model: 'm', messages: [], max_tokens: 10 }), /at least one message/);
  assert.throws(() => buildChatRequest(spec, { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 }), /max_tokens/);
  assert.throws(() => buildChatRequest(spec, { model: 'm', messages: [{ role: 'other' as never, content: 'x' }] }), /role/);
  assert.throws(() => buildChatRequest(spec, { model: 'm', messages: [{ role: 'user', content: 1 as never }] }), /content/);
  assert.throws(() => buildChatRequest(spec, { model: 'm', messages: [{ role: 'user', content: 'x' }], cache_prefix_messages: 9 }), /cache_prefix_messages/);
  const cached = buildChatRequest({
    ...spec, context_cache: { mode: 'automatic_prefix', requires_exact_prefix: true, usage_fields: 'deepseek' },
  }, { model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], cache_prefix_messages: 1 });
  assert.equal(cached.context_cache.eligible, true);
  assert.ok(cached.context_cache.prefix_digest);
});

test('chat responses are normalised and malformed payloads fail closed', () => {
  const spec = defineProvider({ provider: 'local', protocol: 'openai-compatible', base_url: 'http://x', api_key_env: 'K', models: { standard: 'm' } });
  const parsed = parseChatResponse(spec, { choices: [{ message: { content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } }], model: 'm', usage: { prompt_tokens: 10, completion_tokens: 2 } });
  assert.equal(parsed.text, 'hello');
  assert.equal(parsed.model, 'm');
  assert.equal(parsed.tool_calls?.[0]?.function.name, 'f');
  assert.equal(parsed.usage?.input_tokens, 10);
  const anthropic = defineProvider({ provider: 'claude', protocol: 'anthropic', base_url: 'http://x', api_key_env: 'K', models: { standard: 'm' } });
  const claude = parseChatResponse(anthropic, { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'f', input: { a: 1 } }], model: 'm', usage: { input_tokens: 3, output_tokens: 1 } });
  assert.equal(claude.text, 'hi');
  assert.equal(claude.tool_calls?.[0]?.function.arguments, '{"a":1}');
  assert.equal(parseChatResponse(spec, { choices: [{ message: { content: null } }] }).text, '');
  assert.throws(() => parseChatResponse(spec, null), /must be an object/);
  assert.throws(() => parseChatResponse(spec, { choices: [] }), /no message content/);
  assert.throws(() => parseChatResponse(anthropic, { content: [] }), /no text block/);
});

test('the fetch transport retries, reports failures and refuses missing credentials', async () => {
  const spec = defineProvider({ provider: 'local', protocol: 'openai-compatible', base_url: 'http://127.0.0.1:9/v1', api_key_env: 'LOCAL_KEY', models: { standard: 'm' } });
  const request = buildChatRequest(spec, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.throws(() => createFetchTransport({ timeoutMs: 1 }), /timeoutMs/);
  assert.throws(() => createFetchTransport({ maxAttempts: 9 }), /maxAttempts/);
  assert.throws(() => createFetchTransport({ maxResponseBytes: 10 }), /maxResponseBytes/);
  const missing = createFetchTransport({ env: {}, maxAttempts: 1 });
  await assert.rejects(missing.complete(spec, request), /is not configured/);
  const hostManaged = createFetchTransport({ env: { LOCAL_KEY: 'k' }, maxAttempts: 1 });
  await assert.rejects(hostManaged.complete({ ...spec, host_managed_auth: true }, request), /Host-managed/);
  let attempts = 0;
  const retrying = createFetchTransport({
    env: { LOCAL_KEY: 'k' }, maxAttempts: 2, timeoutMs: 1_000,
    fetchImpl: (async () => {
      attempts += 1;
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(retrying.complete(spec, request), /HTTP 500/);
  assert.equal(attempts, 2);
  const ok = createFetchTransport({
    env: { LOCAL_KEY: 'k' }, maxAttempts: 1, timeoutMs: 1_000,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal((await ok.complete(spec, request)).text, 'hi');
  const invalidJson = createFetchTransport({
    env: { LOCAL_KEY: 'k' }, maxAttempts: 1, timeoutMs: 1_000,
    fetchImpl: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
  });
  await assert.rejects(invalidJson.complete(spec, request), /not valid JSON/);
  await assert.rejects(unconfiguredTransport.complete(spec, request), /No model transport/);
});

test('settings round-trip through disk and reject invalid values', async () => {
  const f = await fixture();
  try {
    const defaults = defaultSettings(f.paths);
    assert.equal(defaults.theme, 'system');
    assert.equal(defaults.locale, 'zh-CN');
    assert.equal(defaults.workbench.port, 4173);
    const loaded = await loadSettings(f.paths);
    assert.equal(loaded.workbench.pilotConcurrency, 3);
    const saved = await saveSettings({ locale: 'en-US', theme: 'dark' } as never, f.paths);
    assert.equal(saved.locale, 'en-US');
    assert.equal(saved.theme, 'dark');
    const reloaded = await loadSettings(f.paths);
    assert.equal(reloaded.theme, 'dark');
    assert.equal(isOnboardingComplete(reloaded), false);
    const onboarded = markOnboardingComplete(f.paths, new Date(), 'ws');
    assert.equal(isOnboardingComplete(onboarded), true);
    assert.equal(onboarded.workbench.onboarding.workspaceId, 'ws');
    assert.equal(markOnboardingComplete(f.paths).workbench.onboarding.completedAt, onboarded.workbench.onboarding.completedAt);
    assert.equal(resetOnboarding(f.paths).workbench.onboarding.completedAt, null);
    const sync = loadSettingsSync(f.paths);
    assert.equal(sync.theme, 'dark');
    assert.equal(saveSettingsSync({ theme: 'light' } as never, f.paths).theme, 'light');
    assert.equal(resetSettingsSync(f.paths).theme, 'system');
    assert.equal((await resetSettings(f.paths)).theme, 'system');
    const view = publicSettings(defaults, f.paths);
    assert.equal(view.secretsStored, false);
    assert.ok(String(view.note).includes('never contains API keys'));
    assert.throws(() => normalizeSettings({ locale: 'fr' }, f.paths), /locale/);
    assert.throws(() => normalizeSettings({ theme: 'blue' }, f.paths), /theme/);
    assert.throws(() => normalizeSettings({ updatedAt: 'never' }, f.paths), /ISO timestamp/);
    assert.throws(() => normalizeSettings({ workbench: { browserMode: 'odd' } }, f.paths), /browserMode/);
    assert.throws(() => normalizeSettings({ workbench: { defaultPermission: 'odd' } }, f.paths), /defaultPermission/);
    assert.throws(() => normalizeSettings({ workbench: { dshPluginProfile: 'bad profile' } }, f.paths), /profile identifier/);
    assert.throws(() => normalizeSettings({ lastProvider: 'bad name' }, f.paths), /identifier/);
    assert.throws(() => normalizeSettings({ workbench: { operator: 'a'.repeat(65) } }, f.paths), /64 characters/);
    assert.throws(() => normalizeSettings({ workbench: { operator: 'a\nb' } }, f.paths), /single line/);
    assert.throws(() => normalizeSettings({ workbench: { port: 99_999 } }, f.paths), /workbench.port/);
    assert.throws(() => normalizeSettings({ workbench: { openOnStart: 'yes' } }, f.paths), /boolean/);
    assert.throws(() => normalizeSettings({ workbench: { codexExecutable: 'relative' } }, f.paths), /absolute path/);
    assert.throws(() => normalizeSettings({ runtime: { maxSteps: 0 } }, f.paths), /runtime.maxSteps/);
    assert.throws(() => normalizeSettings({ models: 'nope' }, f.paths), /array/);
    assert.throws(() => normalizeSettings({ models: [{ id: 'a' }, { id: 'a' }] }, f.paths), /Duplicate model id/);
    assert.throws(() => normalizeSettings({ models: [{ id: 'a', protocol: 'other' }] }, f.paths), /protocol/);
    assert.throws(() => normalizeSettings({ models: [{ id: 'a', baseUrl: 'ftp://x' }] }, f.paths), /http or https/);
    assert.throws(() => normalizeSettings({ models: [{ id: 'a', apiKeyEnv: '' }] }, f.paths), /apiKeyEnv/);
    assert.throws(() => normalizeSettings({ workbench: { contextStorage: { memory: { mode: 'mirror' } } } }, f.paths), /path is required/);
    assert.throws(() => normalizeSettings({ workbench: { contextStorage: { memory: { mode: 'other' } } } }, f.paths), /mode/);
    assert.throws(() => normalizeSettings({ privacy: { telemetry: 'yes' } }, f.paths), /boolean/);
    assert.throws(() => normalizeSettings({ workbench: { onboarding: { completedAt: 'never' } } }, f.paths), /ISO timestamp/);
    assert.throws(() => normalizeSettings({ workbench: { onboarding: { workspaceId: 'bad id' } } }, f.paths), /identifier/);
    const withModel = normalizeSettings({ models: [{ id: 'a', name: 'A', protocol: 'openai-compatible', baseUrl: 'http://x', model: 'm', apiKeyEnv: 'A_KEY', supportsTools: false }] }, f.paths);
    assert.equal(withModel.models[0]?.supportsTools, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the mock MCP server answers the protocol and records every call', async () => {
  const f = await fixture();
  try {
    const logPath = join(f.root, 'mcp.log');
    const configPath = join(f.root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      servers: [{
        name: 'fixture', log_path: logPath,
        tools: [
          { name: 'echo', description: 'echo', input_schema: { type: 'object', properties: { text: { type: 'string' } } }, response: { content: [{ type: 'text', text: 'echoed' }] } },
          { name: 'boom', response: { is_error: true } },
        ],
      }],
    }), 'utf8');
    const child = spawn(process.execPath, [MCP_MOCK, '--server', 'fixture', '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buffer = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) if (part.trim()) lines.push(part);
    });
    const send = (message: unknown): void => { child.stdin!.write(`${JSON.stringify(message)}\n`); };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-01-01' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    send({ jsonrpc: '2.0', id: 3, method: 'logging/setLevel', params: { level: 'info' } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing', arguments: {} } });
    send({ jsonrpc: '2.0', id: 7, method: 'unknown/method' });
    child.stdin!.write('not json\n');
    child.stdin!.write('\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.stdin!.end();
    await new Promise((resolve) => child.once('close', resolve));
    const parsed = lines.map((line) => JSON.parse(line) as { id?: number; result?: { protocolVersion?: string; tools?: unknown[]; content?: unknown[]; isError?: boolean }; error?: { code: number } });
    const initialize = parsed.find((item) => item.id === 1);
    assert.equal(initialize?.result?.protocolVersion, '2025-01-01');
    const listed = parsed.find((item) => item.id === 4);
    assert.equal(listed?.result?.tools?.length, 2);
    const called = parsed.find((item) => item.id === 5);
    assert.deepEqual(called?.result?.content, [{ type: 'text', text: 'echoed' }]);
    const missingTool = parsed.find((item) => item.id === 6);
    assert.equal(missingTool?.error?.code, -32602);
    const unknown = parsed.find((item) => item.id === 7);
    assert.equal(unknown?.error?.code, -32601);
    assert.equal(parsed.some((item) => item.error?.code === -32700), true);
    const log = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { tool: string; delivered: boolean });
    assert.equal(log.length, 2);
    assert.equal(log[0]?.delivered, true);
    assert.equal(log[1]?.delivered, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the mock MCP server refuses an unusable configuration', async () => {
  const f = await fixture();
  try {
    const missingArgs = spawnSync(process.execPath, [MCP_MOCK], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(missingArgs.status, 2);
    assert.match(missingArgs.stderr, /requires --server/);
    const configPath = join(f.root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: [] }), 'utf8');
    const unknownServer = spawnSync(process.execPath, [MCP_MOCK, '--server', 'absent', '--config', configPath], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(unknownServer.status, 2);
    assert.match(unknownServer.stderr, /no server named/);
    const unreadable = spawnSync(process.execPath, [MCP_MOCK, '--server', 'absent', '--config', join(f.root, 'missing.json')], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(unreadable.status, 2);
    assert.match(unreadable.stderr, /cannot read config/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
