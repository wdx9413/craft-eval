/**
 * The single evaluation model configuration.
 *
 * Three scripts (`eval-run`, `eval-recurrence`, `eval-suite-run`) previously each
 * declared this provider, its transport and an identical `ask()` — twenty-four
 * lines copied verbatim — and had already drifted: `supports_tools` was `true` in
 * two and `false` in the third. One copy means a change to the endpoint, the model
 * or the credential variable cannot land in one script and miss another.
 *
 * `supports_tools` is now `true` everywhere. That is not a silent behaviour change:
 * `buildChatRequest` never reads the flag — it emits `tools` only when the caller
 * passes them, and no evaluation script does. The flag is provider metadata, and
 * the three copies disagreed without consequence.
 *
 * The credential is no longer embedded. The scripts injected a literal value for
 * `WORKBUDDY_API_KEY`, which overrode the transport's own lookup and put a
 * credential-shaped string in the source tree — one that the project's own secret
 * detectors (`src/federation.ts`, `src/materialization.ts`) would flag. The
 * transport already reads `process.env` by default and already fails with
 * *set WORKBUDDY_API_KEY before running Craft* when the variable is absent, so the
 * configuration here carries only the endpoint and the budget.
 */
import { buildChatRequest, createFetchTransport, credentialStatus, defineProvider, selectModel } from "./model-gateway.ts";
import { sanitizeModelEgressRequest } from "./model-egress-security.ts";

/** The local WorkBuddy gateway stays the default; every field can be redirected. */
const EVAL_DEFAULTS = Object.freeze({
  provider: "workbuddy", label: "WorkBuddy Local", protocol: "openai-compatible" as const,
  base_url: "http://127.0.0.1:8000/v1", api_key_env: "WORKBUDDY_API_KEY",
  model: "deepseek-v4.1-flash", frontier_model: "deepseek-v4-pro",
});

/**
 * The suite must be runnable against whatever gateway the operator actually has,
 * otherwise the safety and value ledgers can never report anything on a machine
 * without a local WorkBuddy. These variables redirect the endpoint without
 * touching a single case:
 *
 *   CRAFT_EVAL_PROVIDER, CRAFT_EVAL_LABEL, CRAFT_EVAL_BASE_URL,
 *   CRAFT_EVAL_API_KEY_ENV, CRAFT_EVAL_MODEL, CRAFT_EVAL_FRONTIER_MODEL
 */
export function evaluationProviderConfig(env: NodeJS.ProcessEnv = process.env): {
  provider: string; label: string; base_url: string; api_key_env: string; model: string; frontier_model: string;
} {
  const model = env.CRAFT_EVAL_MODEL?.trim() || EVAL_DEFAULTS.model;
  return {
    provider: env.CRAFT_EVAL_PROVIDER?.trim() || EVAL_DEFAULTS.provider,
    label: env.CRAFT_EVAL_LABEL?.trim() || EVAL_DEFAULTS.label,
    base_url: env.CRAFT_EVAL_BASE_URL?.trim() || EVAL_DEFAULTS.base_url,
    api_key_env: env.CRAFT_EVAL_API_KEY_ENV?.trim() || EVAL_DEFAULTS.api_key_env,
    model,
    frontier_model: env.CRAFT_EVAL_FRONTIER_MODEL?.trim() || EVAL_DEFAULTS.frontier_model,
  };
}

const EVAL_CONFIG = evaluationProviderConfig();

export const EVAL_PROVIDER = defineProvider({
  provider: EVAL_CONFIG.provider, label: EVAL_CONFIG.label, protocol: EVAL_DEFAULTS.protocol,
  base_url: EVAL_CONFIG.base_url, api_key_env: EVAL_CONFIG.api_key_env, chat_path: "/chat/completions",
  models: { small: EVAL_CONFIG.model, standard: EVAL_CONFIG.model, frontier: EVAL_CONFIG.frontier_model },
  supports_tools: true,
});

export const EVAL_MODEL = selectModel(EVAL_PROVIDER, "standard").model;

/**
 * Fail before the first case when the credential is absent.
 *
 * Without this, every case's `try/catch` turns the transport's
 * *set WORKBUDDY_API_KEY* error into an empty answer and grades it `FAIL`, so a run
 * with no credential reports a model that answered everything wrong and exits 0.
 * That is an environment failure wearing a capability failure's clothes — the same
 * mistake the gates and the suite each had to be taught not to make.
 */
/**
 * Report whether the evaluation gateway is configured. The old behaviour threw
 * here, which aborted the *whole* suite before any kernel case ran — exactly the
 * "environment failure wearing a capability failure's clothes" problem the
 * comment above warns about, only one level up. A missing credential must be
 * recorded as `inconclusive` for the model-output cases while the kernel cases
 * still run; the safety ledger then reports NO OBSERVATION, not a crash.
 */
export function evaluationCredentialMissing(): string | null {
  const status = credentialStatus(EVAL_PROVIDER);
  return status.configured ? null
    : `${status.api_key_env} is not set; copy .env.example to .env.local and fill it, then run \`pnpm run eval:local\` (or export CRAFT_EVAL_BASE_URL, CRAFT_EVAL_MODEL, CRAFT_EVAL_API_KEY_ENV and the key itself). The current provider is ${EVAL_PROVIDER.provider} at ${EVAL_PROVIDER.base_url}; model cases stay inconclusive, never failed.`;
}

/** Fail-fast variant retained for `eval:live` / recurrence, which cannot produce a meaningful report without a model. */
export function requireEvaluationCredential(): void {
  const missing = evaluationCredentialMissing();
  if (missing) throw new Error(missing);
}

// One transport for the process. It resolves the credential per request from
// `process.env`, so a missing key fails on the first turn with the transport's own
// message rather than being papered over by a placeholder.
const transport = createFetchTransport({ timeoutMs: 90_000, maxAttempts: 1 });

/**
 * One deterministic prompt turn.
 *
 * `maxTokens` is the only difference the three copies ever had (64, 32, 64), so it
 * is the only argument.
 *
 * The default budget is 1024, not 64. A reasoning model spends part of
 * `max_tokens` on hidden reasoning before it emits any content: probing a
 * `group/free`-style gateway showed `max_tokens: 32` returning
 * `output_tokens: 32` and zero visible text, while 512 returned the graded
 * answer. A small budget therefore looked like a wrong answer when it was a
 * budget limit. Callers that pass an explicit budget still get exactly that.
 *
 * An empty visible answer with the budget exhausted is reported as a budget
 * error rather than returned as "", so the suite records an environment
 * limitation instead of grading a blank answer as a capability failure.
 */
export const EVAL_ANSWER_MAX_TOKENS = 1024;

export interface EvalTrial {
  text: string;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  elapsed_ms: number;
  max_tokens: number;
}

/** One observed model turn, with the byte-level result and its cost signals. */
export async function askTrial(prompt: string, maxTokens = EVAL_ANSWER_MAX_TOKENS): Promise<EvalTrial> {
  const request = buildChatRequest(EVAL_PROVIDER, {
    model: EVAL_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0,
  });
  // Final destination + content check immediately before the bytes leave.
  const started = Date.now();
  const result = await transport.complete(EVAL_PROVIDER, sanitizeModelEgressRequest(EVAL_PROVIDER, request));
  const elapsed = Date.now() - started;
  const answer = result.text.trim();
  if (!answer && result.usage && result.usage.output_tokens >= maxTokens) {
    throw new Error(`model produced no visible answer within max_tokens=${maxTokens} (reasoning likely consumed the budget); raise the budget or use a non-reasoning model`);
  }
  return { text: answer, model: result.model, usage: result.usage, elapsed_ms: elapsed, max_tokens: maxTokens };
}

export async function ask(prompt: string, maxTokens = EVAL_ANSWER_MAX_TOKENS): Promise<string> {
  return (await askTrial(prompt, maxTokens)).text;
}
