import type { JsonObject } from '../../craft-common/packages/craft-common-store-local/src/store.ts';
import { normalizeModelPricing, type CraftModelConfig, type ModelProtocol, type ModelPricing } from "./settings.ts";
export type { ModelPricing } from "./settings.ts";
import { text } from '../../craft-common/packages/craft-common-base/src/validation.ts';
import { stableDigest } from "./digest.ts";
import { DEFAULT_RULES, Sanitizer } from '../../craft-capability/capability/craft-datasec/rules.ts';
import { sanitizeModelEgressRequest } from "./model-egress-security.ts";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The model gateway.
 *
 * Models are user-configured (stored in settings.json). Each model has a
 * protocol (openai-compatible or anthropic), a base URL, a model name, and
 * the name of the environment variable that holds the API key. Keys are
 * never stored in settings — only the env-var name is.
 */

export type { ModelProtocol };
export type ModelTier = "small" | "standard" | "frontier";

/**
 * A provider's cache is a provider-side optimisation, not a second Craft
 * store.  The only portable control Craft has is keeping a reusable prefix
 * byte-for-byte stable and recording what the provider actually reported.
 */
export interface ContextCacheSpec {
  readonly mode: "none" | "automatic_prefix";
  readonly requires_exact_prefix: boolean;
  readonly usage_fields: "none" | "deepseek";
}

const NO_CONTEXT_CACHE: ContextCacheSpec = { mode: "none", requires_exact_prefix: false, usage_fields: "none" };
const DEEPSEEK_CONTEXT_CACHE: ContextCacheSpec = { mode: "automatic_prefix", requires_exact_prefix: true, usage_fields: "deepseek" };

export interface ModelProviderSpec {
  provider: string;
  label: string;
  protocol: ModelProtocol;
  base_url: string;
  api_key_env: string;
  chat_path: string;
  models: Partial<Record<ModelTier, string>>;
  /** A relative ordering hint; it is never presented as a price. */
  cost_hint: number;
  supports_tools: boolean;
  /** Authentication is supplied by an installed Host CLI instead of an API key. */
  host_managed_auth?: boolean;
  /** Optional for adapters compiled against the pre-cache public contract. */
  context_cache?: ContextCacheSpec;
  pricing?: Record<string, ModelPricing>;
}

const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const TIER_ORDER: readonly ModelTier[] = ["frontier", "standard", "small"];

/**
 * Built-in declarations keep a freshly installed runtime observable before the
 * user has added a private model configuration. They are never credentials and
 * a declared provider is still unusable until its environment variable exists.
 */
export const PROVIDER_CATALOG: readonly ModelProviderSpec[] = [
  { provider: "codex-cli", label: "Codex CLI Host", protocol: "openai-compatible", base_url: "https://codex-cli-host.invalid", api_key_env: "CODEX_CLI_AUTH_STORE", chat_path: "/host/exec", models: { small: "gpt-6-luna" }, cost_hint: 1, supports_tools: false, host_managed_auth: true, context_cache: NO_CONTEXT_CACHE },
  { provider: "deepseek", label: "DeepSeek", protocol: "openai-compatible", base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY", chat_path: "/chat/completions", models: { small: "deepseek-chat", standard: "deepseek-chat", frontier: "deepseek-reasoner" }, cost_hint: 1, supports_tools: true, context_cache: DEEPSEEK_CONTEXT_CACHE },
  { provider: "volcengine", label: "火山引擎方舟", protocol: "openai-compatible", base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key_env: "ARK_API_KEY", chat_path: "/chat/completions", models: { small: "doubao-lite", standard: "doubao-pro", frontier: "doubao-pro-32k" }, cost_hint: 2, supports_tools: true, context_cache: NO_CONTEXT_CACHE },
  { provider: "qwen", label: "通义千问", protocol: "openai-compatible", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key_env: "DASHSCOPE_API_KEY", chat_path: "/chat/completions", models: { small: "qwen-turbo", standard: "qwen-plus", frontier: "qwen-max" }, cost_hint: 2, supports_tools: true, context_cache: NO_CONTEXT_CACHE },
  { provider: "kimi", label: "Kimi (Moonshot)", protocol: "openai-compatible", base_url: "https://api.moonshot.cn/v1", api_key_env: "MOONSHOT_API_KEY", chat_path: "/chat/completions", models: { small: "moonshot-v1-8k", standard: "moonshot-v1-32k", frontier: "moonshot-v1-128k" }, cost_hint: 2, supports_tools: true, context_cache: NO_CONTEXT_CACHE },
  { provider: "glm", label: "智谱 GLM", protocol: "openai-compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", api_key_env: "ZHIPU_API_KEY", chat_path: "/chat/completions", models: { small: "glm-4-flash", standard: "glm-4-air", frontier: "glm-4-plus" }, cost_hint: 1, supports_tools: true, context_cache: NO_CONTEXT_CACHE },
  { provider: "minimax", label: "MiniMax", protocol: "openai-compatible", base_url: "https://api.minimax.chat/v1", api_key_env: "MINIMAX_API_KEY", chat_path: "/text/chatcompletion_v2", models: { standard: "abab6.5s-chat", frontier: "abab6.5-chat" }, cost_hint: 2, supports_tools: false, context_cache: NO_CONTEXT_CACHE },
  { provider: "gpt", label: "OpenAI GPT", protocol: "openai-compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", chat_path: "/chat/completions", models: { small: "gpt-4o-mini", standard: "gpt-4o", frontier: "gpt-4.1" }, cost_hint: 6, supports_tools: true, context_cache: NO_CONTEXT_CACHE },
  { provider: "claude", label: "Anthropic Claude", protocol: "anthropic", base_url: "https://api.anthropic.com/v1", api_key_env: "ANTHROPIC_API_KEY", chat_path: "/messages", models: { small: "claude-haiku-4", standard: "claude-sonnet-4", frontier: "claude-opus-4" }, cost_hint: 7, supports_tools: true, context_cache: NO_CONTEXT_CACHE },
];



function httpUrl(value: unknown, name: string): string {
  const raw = text(value, name); let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials or query data`);
  }
  return raw.replace(/\/+$/u, "");
}

function cacheSpec(provider: string, baseUrl: string, value: unknown): ContextCacheSpec {
  if (value === undefined) return provider === "deepseek" || new URL(baseUrl).hostname === "api.deepseek.com" ? DEEPSEEK_CONTEXT_CACHE : NO_CONTEXT_CACHE;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context_cache must be an object");
  const input = value as JsonObject;
  const mode = text(input.mode, "context_cache.mode");
  const usageFields = text(input.usage_fields ?? "none", "context_cache.usage_fields");
  if (mode !== "none" && mode !== "automatic_prefix") throw new Error("context_cache.mode is unsupported");
  if (usageFields !== "none" && usageFields !== "deepseek") throw new Error("context_cache.usage_fields is unsupported");
  if (typeof input.requires_exact_prefix !== "boolean") throw new Error("context_cache.requires_exact_prefix must be boolean");
  return { mode, usage_fields: usageFields, requires_exact_prefix: input.requires_exact_prefix };
}

/** Define and validate a legacy provider declaration used by the runtime API. */
export function defineProvider(input: JsonObject): ModelProviderSpec {
  const provider = text(input.provider, "provider");
  if (!PROVIDER_NAME.test(provider)) throw new Error(`Unsupported provider name: ${provider}`);
  const protocol = text(input.protocol, "protocol");
  if (protocol !== "openai-compatible" && protocol !== "anthropic") throw new Error(`Unsupported provider protocol: ${protocol}`);
  const apiKeyEnv = text(input.api_key_env, "api_key_env");
  if (!ENV_NAME.test(apiKeyEnv)) throw new Error("api_key_env must be an uppercase environment-variable name");
  const rawModels = (input.models ?? {}) as JsonObject;
  if (typeof rawModels !== "object" || Array.isArray(rawModels)) throw new Error("provider models must be an object");
  const models: Partial<Record<ModelTier, string>> = {};
  for (const tier of TIER_ORDER) {
    const value = rawModels[tier]; if (value !== undefined && value !== null) models[tier] = text(value, `models.${tier}`);
  }
  if (!Object.keys(models).length) throw new Error("provider must declare at least one model tier");
  const supportsTools = input.supports_tools ?? true;
  if (typeof supportsTools !== "boolean") throw new Error("supports_tools must be a boolean");
  const costHint = input.cost_hint === undefined ? 1 : Number(input.cost_hint);
  if (!Number.isFinite(costHint) || costHint < 0) throw new Error("cost_hint must be a non-negative number");
  const baseUrl = httpUrl(input.base_url, "base_url");
  let pricing: Record<string, ModelPricing> | undefined;
  if (input.pricing !== undefined) {
    if (!input.pricing || typeof input.pricing !== "object" || Array.isArray(input.pricing)) throw new Error("pricing must be an object");
    pricing = Object.fromEntries(Object.entries(input.pricing as JsonObject).map(([model, value]) => {
      if (!Object.values(models).includes(model) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("pricing must name a configured model and a price object");
      const price = normalizeModelPricing(value)!;
      return [model, price];
    }));
  }
  return { provider, label: input.label === undefined ? provider : text(input.label, "label"), protocol: protocol as ModelProtocol,
    base_url: baseUrl, api_key_env: apiKeyEnv,
    chat_path: input.chat_path === undefined ? (protocol === "anthropic" ? "/messages" : "/chat/completions") : text(input.chat_path, "chat_path"),
    models, cost_hint: costHint, supports_tools: supportsTools, ...(pricing === undefined ? {} : { pricing }),
    ...(input.host_managed_auth === true ? { host_managed_auth: true } : {}), context_cache: cacheSpec(provider, baseUrl, input.context_cache) };
}

export interface ChatToolDefinition { type: "function"; function: { name: string; description?: string; parameters?: JsonObject } }
export interface ChatToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: ChatToolCall[] }
export interface ContextCacheLayout { mode: ContextCacheSpec["mode"]; eligible: boolean; prefix_message_count: number; prefix_digest: string | null; reason: string | null }
export interface ChatRequest { url: string; headers: JsonObject; body: JsonObject; prompt_tokens_estimate: number; context_cache: ContextCacheLayout }
export interface ChatResult { text: string; model: string | null; usage: { input_tokens: number; output_tokens: number; cache_hit_tokens?: number; cache_miss_tokens?: number } | null; tool_calls?: ChatToolCall[] }

/** Configured prices only; unknown usage or cache rates never imply zero cost. */
export function priceModelUsage(spec: ModelProviderSpec, model: string, usage: ChatResult["usage"]): { price_version: string; cost_usd: number; rounding: "ceil_micro_usd" } | null {
  const price = spec.pricing?.[model];
  if (!price || !usage) return null;
  for (const value of [usage.input_tokens, usage.output_tokens, usage.cache_hit_tokens ?? 0]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Pricing requires non-negative safe integer token counts");
  const cached = usage.cache_hit_tokens ?? 0;
  if (cached > usage.input_tokens) throw new Error("Cached tokens exceed input tokens");
  if (cached > 0 && price.cached_input_usd_per_million === undefined) return null;
  const micros = (usage.input_tokens - cached) * price.input_usd_per_million + usage.output_tokens * price.output_usd_per_million + cached * (price.cached_input_usd_per_million ?? 0);
  if (!Number.isFinite(micros) || micros < 0 || Math.ceil(micros) > Number.MAX_SAFE_INTEGER) throw new Error("Model cost exceeds supported monetary range");
  return { price_version: price.version, cost_usd: Math.ceil(micros) / 1_000_000, rounding: "ceil_micro_usd" };
}

/** Build a provider spec from a user-configured model entry. */
export function specFromConfig(model: CraftModelConfig): ModelProviderSpec {
  const chatPath = model.protocol === "anthropic" ? "/messages" : "/chat/completions";
  return {
    provider: model.id,
    label: model.name || model.id,
    protocol: model.protocol,
    base_url: model.baseUrl,
    api_key_env: model.apiKeyEnv,
    chat_path: chatPath,
    models: { standard: model.model }, cost_hint: 1,
    ...(model.pricing === undefined ? {} : { pricing: { [model.model]: model.pricing } }),
    supports_tools: model.supportsTools, context_cache: cacheSpec(model.id, model.baseUrl, undefined),
  };
}

/** Convert an array of user models to provider specs. */
export function specsFromModels(models: CraftModelConfig[]): ModelProviderSpec[] {
  return models.map(specFromConfig);
}

/** Public, secret-free view of a model config. */
export function publicModel(model: CraftModelConfig, env: NodeJS.ProcessEnv = process.env): JsonObject {
  const value = env[model.apiKeyEnv];
  const configured = typeof value === "string" && value.length > 0;
  return { id: model.id, name: model.name, protocol: model.protocol,
    baseUrl: model.baseUrl, model: model.model, apiKeyEnv: model.apiKeyEnv,
    ...(model.pricing === undefined ? {} : { pricing: model.pricing as unknown as JsonObject }),
    configured, supportsTools: model.supportsTools, context_cache: cacheSpec(model.id, model.baseUrl, undefined) };
}

/**
 * Legacy wrapper: public view of a provider spec. Kept for callers that
 * still work with ModelProviderSpec objects (runtime, internal host, etc.).
 */
export function publicProvider(spec: ModelProviderSpec, env: NodeJS.ProcessEnv = process.env): JsonObject {
  if (spec.host_managed_auth) return { provider: spec.provider, label: spec.label, protocol: spec.protocol,
    base_url: spec.base_url, api_key_env: "host-managed-auth-store", models: spec.models,
    cost_hint: spec.cost_hint, supports_tools: spec.supports_tools, configured: true,
    host_managed_auth: true, context_cache: spec.context_cache ?? NO_CONTEXT_CACHE };
  const value = env[spec.api_key_env];
  const configured = typeof value === "string" && value.length > 0;
  return { provider: spec.provider, label: spec.label, protocol: spec.protocol,
    base_url: spec.base_url, api_key_env: spec.api_key_env,
    models: spec.models, cost_hint: spec.cost_hint, supports_tools: spec.supports_tools, context_cache: spec.context_cache ?? NO_CONTEXT_CACHE, configured };
}

/**
 * Check whether a provider spec has its API key configured in the environment.
 */
export function credentialStatus(spec: ModelProviderSpec, env: NodeJS.ProcessEnv = process.env): { provider: string; configured: boolean; api_key_env: string } {
  if (spec.host_managed_auth) return { provider: spec.provider, configured: true, api_key_env: "host-managed-auth-store" };
  const value = env[spec.api_key_env];
  return { provider: spec.provider, configured: typeof value === "string" && value.length > 0, api_key_env: spec.api_key_env };
}

/**
 * Legacy tier selection. User-configured models only have one model, so every
 * tier resolves to the same "standard" model. Kept for compatibility with
 * callers that still pass a tier parameter.
 */
export function selectModel(spec: ModelProviderSpec, tier: ModelTier): { tier: ModelTier; model: string; downgraded: boolean } {
  if (!TIER_ORDER.includes(tier)) throw new Error(`Unsupported model tier: ${String(tier)}`);
  for (let index = TIER_ORDER.indexOf(tier); index < TIER_ORDER.length; index += 1) {
    const candidate = TIER_ORDER[index]; const model = spec.models[candidate];
    if (model) return { tier: candidate, model, downgraded: candidate !== tier };
  }
  throw new Error(`Provider ${spec.provider} declares no usable model tier`);
}

/**
 * Render a request for the two wire formats. Only the shape is built here; the
 * API key is read at call time from the environment by the transport, so it can
 * never end up inside a stored record.
 *
 * The authorization header therefore records the *name* of the environment
 * variable the transport should read — never a value, and never the literal
 * `${...}` source text of a template. The previous form emitted the literal
 * string `Bearer $WORKBUDDY_API_KEY`, which announced a credential to anyone
 * inspecting the built request while being a valid-looking header: the transport
 * happened to rebuild its own headers and masked the defect. It is named here as
 * `env:NAME` so a reader can tell at a glance that no secret is present.
 */
export function buildChatRequest(spec: ModelProviderSpec, options: {
  model: string; messages: ChatMessage[]; max_tokens?: number; temperature?: number; tools?: ChatToolDefinition[]; stream?: boolean; cache_prefix_messages?: number;
}): ChatRequest {
  const model = text(options.model, "model");
  const maxTokens = options.max_tokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("max_tokens must be a positive safe integer");
  if (!Array.isArray(options.messages) || !options.messages.length) throw new Error("chat request requires at least one message");
  const sanitizer = new Sanitizer(DEFAULT_RULES.map((rule) => ({ ...rule, enabled: true })), () => "[REDACTED]");
  const scrub = (value: string): string => sanitizer.text(value).replace(/((?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*["']?(?:bearer\s+)?)([^\s"',;}]+)/giu, "$1[REDACTED]");
  const redactExample = (value: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("Model request nesting exceeds redaction limit");
    if (typeof value === "string") return "[REDACTED]";
    if (Array.isArray(value)) return value.map((item) => redactExample(item, depth + 1));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExample(item, depth + 1)]));
    return value;
  };
  const scrubJson = (value: unknown, depth = 0, sensitiveProperty = false): unknown => {
    if (depth > 64) throw new Error("Model request nesting exceeds redaction limit");
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map((item) => scrubJson(item, depth + 1, sensitiveProperty));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === "properties" && item !== null && typeof item === "object" && !Array.isArray(item)) {
        return [key, Object.fromEntries(Object.entries(item).map(([property, schema]) => [property,
          scrubJson(schema, depth + 2, /(?:password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie)/iu.test(property))]))];
      }
      if (sensitiveProperty && ["default", "example", "examples", "enum", "const"].includes(key)) return [key, redactExample(item, depth + 1)];
      return [key, scrubJson(item, depth + 1, sensitiveProperty)];
    }));
    return value;
  };
  const messages = options.messages.map((message, index) => {
    if (!message || typeof message !== "object") throw new Error(`chat message ${index} must be an object`);
    if (!["system", "user", "assistant", "tool"].includes(message.role)) throw new Error(`chat message ${index} has an unsupported role`);
    if (message.content !== null && typeof message.content !== "string") throw new Error(`chat message ${index} content must be a string or null`);
    return { ...message, content: message.content === null ? null : scrub(message.content),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: scrub(call.function.arguments) } })) } : {}) };
  });
  const prefixCount = options.cache_prefix_messages ?? 0;
  if (!Number.isInteger(prefixCount) || prefixCount < 0 || prefixCount > messages.length) throw new Error("cache_prefix_messages must be between 0 and the message count");
  const reusablePrefix = messages.slice(0, prefixCount);
  const cache = spec.context_cache ?? NO_CONTEXT_CACHE;
  const contextCache: ContextCacheLayout = cache.mode === "automatic_prefix" && reusablePrefix.length > 0
    ? { mode: "automatic_prefix", eligible: true, prefix_message_count: reusablePrefix.length, prefix_digest: stableDigest(reusablePrefix), reason: null }
    : { mode: cache.mode, eligible: false, prefix_message_count: reusablePrefix.length,
      prefix_digest: reusablePrefix.length ? stableDigest(reusablePrefix) : null,
      reason: cache.mode === "none" ? "provider_cache_unsupported" : "no_reusable_prefix" };
  const promptChars = messages.reduce((total, message) => total + String(message.content ?? "").length, 0);
  const promptTokensEstimate = Math.max(1, Math.ceil(promptChars / 4));
  const headers: JsonObject = { "content-type": "application/json" };
  let body: JsonObject;
  if (spec.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    const system = messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n");
    body = { model, max_tokens: maxTokens,
       messages: messages.filter((message) => message.role !== "system").map((message) => message.role === "tool"
         ? ({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "unknown", content: message.content ?? "" }] } as JsonObject)
         : ({ ...message, ...(message.tool_call_id ? { tool_use_id: message.tool_call_id } : {}) } as JsonObject)),
      ...(system ? { system } : {}), ...(options.tools?.length ? { tools: options.tools.map((tool) => scrubJson({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters ?? { type: "object" } })) } : {}), ...(options.stream ? { stream: true } : {}) };
  } else {
    headers.authorization = `env:${spec.api_key_env}`;
    body = { model, messages, max_tokens: maxTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }), ...(options.tools?.length ? { tools: scrubJson(options.tools) } : {}), ...(options.stream ? { stream: true } : {}) };
  }
  return { url: `${spec.base_url}${spec.chat_path}`, headers, body, prompt_tokens_estimate: promptTokensEstimate, context_cache: contextCache };
}

/** Normalize either wire format into text plus usage. A malformed payload fails closed. */
export function parseChatResponse(spec: ModelProviderSpec, payload: unknown): ChatResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Model response must be an object");
  const body = payload as JsonObject;
  if (spec.protocol === "anthropic") {
    const blocks = Array.isArray(body.content) ? body.content as JsonObject[] : [];
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
    if (!text) throw new Error("Anthropic response contained no text block");
    const usage = body.usage as JsonObject | undefined;
    const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block, index) => ({ id: String(block.id ?? `tool_${index + 1}`), type: "function" as const, function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) } }));
    return { text, model: body.model === undefined ? null : String(body.model), ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      usage: usage ? { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0) } : null };
  }
  const choices = Array.isArray(body.choices) ? body.choices as JsonObject[] : [];
  const message = choices[0]?.message as JsonObject | undefined;
  if (!message || (message.content !== null && typeof message.content !== "string")) throw new Error("OpenAI-compatible response contained no message content");
  const usage = body.usage as JsonObject | undefined;
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as JsonObject[]).map((item, index) => {
    const fn = item.function as JsonObject;
    return { id: String(item.id ?? `tool_${index + 1}`), type: "function" as const, function: { name: String(fn.name), arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) } };
  }) : [];
  const inputTokens = Number(usage?.prompt_tokens ?? 0);
  const cachedDetails = usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object" && !Array.isArray(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as JsonObject : null;
  const hasCachedFromDetails = typeof cachedDetails?.cached_tokens === "number";
  const hasDeepSeekCache = typeof usage?.prompt_cache_hit_tokens === "number" || typeof usage?.prompt_cache_miss_tokens === "number" || hasCachedFromDetails;
  const cache = spec.context_cache ?? NO_CONTEXT_CACHE;
  const cacheHit = cache.usage_fields === "deepseek" && hasDeepSeekCache
    ? Number(usage?.prompt_cache_hit_tokens ?? cachedDetails?.cached_tokens ?? (typeof usage?.prompt_cache_miss_tokens === "number" ? 0 : undefined)) : null;
  const knownCacheHit = cacheHit !== null && Number.isFinite(cacheHit) ? cacheHit : 0;
  const cacheMiss = cache.usage_fields === "deepseek" && hasDeepSeekCache ? Number(usage?.prompt_cache_miss_tokens ?? Math.max(0, inputTokens - knownCacheHit)) : null;
  const cacheUsage = cacheHit !== null && cacheMiss !== null && Number.isFinite(cacheHit) && cacheHit >= 0 && Number.isFinite(cacheMiss) && cacheMiss >= 0
    ? { cache_hit_tokens: cacheHit, cache_miss_tokens: cacheMiss } : {};
  return { text: message.content === null ? "" : message.content, model: body.model === undefined ? null : String(body.model), ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    usage: usage ? { input_tokens: inputTokens, output_tokens: Number(usage.completion_tokens ?? 0), ...cacheUsage } : null };
}

/**
 * The transport seam. Craft ships no network client in this version, so the
 * default refuses with an actionable message instead of pretending to run; a
 * deployment (or a test) injects a real one.
 */
export interface ModelTransport {
  /** Trusted bound for all billable input tokens of this exact request, including tool schemas.
   * A character estimate is not a quote. Output is bounded by request.body.max_tokens.
   */
  quote?(spec: ModelProviderSpec, request: ChatRequest, signal?: AbortSignal): Promise<{ input_tokens_upper_bound: number }>;

  complete(spec: ModelProviderSpec, request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  /** Optional per-worker budget check performed before an external model call. */
  acquireCall?(provider: string): boolean;
}

export interface FetchTransportOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
}

function responseError(status: number, body: string): Error {
  const detail = body.replace(/\s+/gu, " ").trim().slice(0, 300);
  return new Error(`Model request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

class ModelResponseTooLarge extends Error {}

async function readModelResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ModelResponseTooLarge(`Model response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The built-in network transport. It deliberately uses the platform fetch API
 * rather than adding an SDK per provider: the config already normalizes the
 * two wire formats and this keeps the code small and cross-platform.
 */
export function createFetchTransport(options: FetchTransportOptions = {}): ModelTransport {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error("timeoutMs must be between 100 and 300000");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("maxAttempts must be between 1 and 5");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024) throw new Error("maxResponseBytes must be at least 1024");
  return {
    complete: async (spec, request, signal) => {
      signal?.throwIfAborted();
      if (spec.host_managed_auth) throw new Error(`Model ${spec.provider} requires its Host-managed transport.`);
      const outbound = sanitizeModelEgressRequest(spec, request);
      const key = env[spec.api_key_env]?.trim();
      if (!key) throw new Error(`Model ${spec.provider} is not configured; set ${spec.api_key_env} before running Craft.`);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (spec.protocol === "anthropic") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.authorization = `Bearer ${key}`;
      }
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let retryable = true;
        try {
          const response = await fetchImpl(outbound.url, { method: "POST", headers, body: JSON.stringify(outbound.body), signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
          const body = await readModelResponse(response, maxResponseBytes);
          signal?.throwIfAborted();
          if (response.ok) {
            let parsed: unknown;
            try { parsed = JSON.parse(body); } catch { throw new Error("Model response was not valid JSON"); }
            return parseChatResponse(spec, parsed);
          }
          lastError = responseError(response.status, body);
          retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          if (!retryable || attempt === maxAttempts) throw lastError;
          const retryAfter = Number(response.headers.get("retry-after") ?? "0");
          await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 10_000) : attempt * 250, undefined, { signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof ModelResponseTooLarge) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!retryable || attempt === maxAttempts) throw lastError;
          if (lastError.name === "AbortError") lastError = new Error(`Model request timed out after ${timeoutMs}ms`);
          await delay(attempt * 250, undefined, { signal });
        } finally {
          clearTimeout(timer);
        }
      }
      // maxAttempts is validated as a positive integer, so every exhausted
      // loop has either captured or thrown the last transport error.
      throw lastError as Error;
    },
  };
}

/** Backward-compat alias — prefer specFromConfig. */
export function providerFromConfig(input: { protocol: ModelProtocol; name: string; baseUrl: string; model: string; apiKeyEnv?: string }): ModelProviderSpec {
  const normalized = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "") || "custom";
  return defineProvider({ provider: normalized, label: input.name.trim() || normalized, protocol: input.protocol,
    base_url: input.baseUrl, api_key_env: input.apiKeyEnv || "CRAFT_API_KEY", models: { standard: input.model }, supports_tools: true, cost_hint: 1 });
}

export const unconfiguredTransport: ModelTransport = {
  complete: async (spec) => {
    throw new Error(`No model transport is installed for ${spec.provider}; set ${spec.api_key_env} and enable the internal host before running the loop.`);
  },
};
