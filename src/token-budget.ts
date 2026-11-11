import { text } from "./validation.ts";
/**
 * Deterministic token accounting and model routing.
 *
 * Nothing here calls a model or a tokenizer. Craft needs an *estimate* it can
 * reproduce on any platform, because the point is to decide before spending:
 * which tier runs a task, and when a loop must stop. A budget that overshoots
 * reports the overshoot instead of throwing, so the caller always gets a number
 * to reason about.
 */
export type ModelTier = "small" | "standard" | "frontier";

export interface BudgetState { limit: number; reserve: number; used: number }

export interface ComplexitySignals {
  steps: number;
  distinct_paths: number;
  context_chars: number;
  requires_external_write: boolean;
  requires_multi_step_reasoning: boolean;
}

export interface RoutingRequest { host: string; models: Partial<Record<ModelTier, string>>; tier: ModelTier }
export interface RoutingDecision { tier: ModelTier; model: string | null; downgraded: boolean; reason: string }

// Non-global on purpose: a /g regex carries lastIndex across `.test()` calls and
// would make the same character classify differently depending on its position.
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
/** Most real tasks need only basic reasoning, so these thresholds keep the frontier tier rare on purpose. */
const STANDARD_STEPS = 4;
const FRONTIER_STEPS = 12;
const STANDARD_PATHS = 3;
const FRONTIER_PATHS = 10;
const STANDARD_CONTEXT_CHARS = 20_000;
const TIER_ORDER: readonly ModelTier[] = ["frontier", "standard", "small"];

function count(value: unknown, name: string): number {
  const result = Number(value ?? 0);
  if (!Number.isInteger(result) || result < 0) throw new Error(`${name} must be a non-negative integer`);
  return result;
}

/**
 * A platform-independent approximation: one token per CJK character and roughly
 * four characters per token otherwise. It is deliberately conservative and never
 * returns zero, so an empty string still costs something to reason about.
 */
export function estimateTokens(value: string): number {
  if (typeof value !== "string") throw new Error("Token estimation requires a string");
  const characters = [...value];
  const cjk = characters.filter((character) => CJK.test(character)).length;
  return Math.max(1, Math.ceil(cjk + (characters.length - cjk) / 4));
}

export function estimatePromptTokens(texts: readonly string[]): number {
  if (!Array.isArray(texts)) throw new Error("Token estimation requires an array of strings");
  return texts.reduce((total, item) => total + estimateTokens(item), 0);
}

export function createBudgetState(limit: number, reserve = 0): BudgetState {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Token budget limit must be a positive integer");
  if (!Number.isInteger(reserve) || reserve < 0 || reserve >= limit) {
    throw new Error("Token budget reserve must be a non-negative integer below the limit");
  }
  return { limit, reserve, used: 0 };
}

export function remainingTokens(state: BudgetState): number {
  return state.limit - state.reserve - state.used;
}

/**
 * Charge the budget. Overspending is reported, never thrown: the caller needs
 * the measurement in order to stop the loop, and an exception would lose it.
 */
export function spendTokens(state: BudgetState, amount: number): { state: BudgetState; exceeded: boolean; remaining: number } {
  if (!Number.isInteger(amount) || amount < 0) throw new Error("Token spend must be a non-negative integer");
  const used = state.used + amount;
  const remaining = state.limit - state.reserve - used;
  return { state: { ...state, used }, exceeded: remaining < 0, remaining };
}

/** Cap one payload — a tool result, a log tail, a file read — before it reaches a model. */
export function truncateToBudget(value: string, maxTokens: number): { text: string; truncated: boolean; estimated_tokens: number } {
  if (typeof value !== "string") throw new Error("Token truncation requires a string");
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("Token cap must be a positive integer");
  const estimated = estimateTokens(value);
  if (estimated <= maxTokens) return { text: value, truncated: false, estimated_tokens: estimated };
  // Keep the head: a truncated payload usually fails at its tail, and the head
  // preserves the shape the model needs to reason about what it is looking at.
  // Include the marker in the same estimate. Character ratios do not bound a
  // prefix when its CJK density differs from the full payload's density.
  const marker = maxTokens >= estimateTokens("…[truncated]") ? "…[truncated]" : "…";
  const characters = [...value];
  let keep = 0; let upper = characters.length;
  while (keep < upper) {
    const middle = Math.ceil((keep + upper) / 2);
    if (estimateTokens(characters.slice(0, middle).join("") + marker) <= maxTokens) keep = middle;
    else upper = middle - 1;
  }
  const clipped = characters.slice(0, keep).join("") + marker;
  return { text: clipped, truncated: true, estimated_tokens: estimateTokens(clipped) };
}

/** Classify a task from structural signals only. The same signals always give the same tier. */
export function classifyComplexity(signals: ComplexitySignals): ModelTier {
  const steps = count(signals.steps, "steps");
  const paths = count(signals.distinct_paths, "distinct_paths");
  const contextChars = count(signals.context_chars, "context_chars");
  if (signals.requires_multi_step_reasoning || signals.requires_external_write
    || steps >= FRONTIER_STEPS || paths >= FRONTIER_PATHS) return "frontier";
  if (contextChars >= STANDARD_CONTEXT_CHARS || steps >= STANDARD_STEPS || paths >= STANDARD_PATHS) return "standard";
  return "small";
}

/**
 * Pick a model for a tier. The search walks *down* from the requested tier and
 * never up, so a missing model degrades to something cheaper instead of
 * silently promoting the task to a costlier one. `model: null` means "let the
 * host use its own default", which is also the outcome when nothing is declared.
 */
export function routeModel(request: RoutingRequest): RoutingDecision {
  const host = text(request.host, "host");
  const start = TIER_ORDER.indexOf(request.tier);
  if (start === -1) throw new Error(`Unsupported model tier: ${String(request.tier)}`);
  for (let index = start; index < TIER_ORDER.length; index += 1) {
    const tier = TIER_ORDER[index];
    const declared = request.models[tier];
    if (typeof declared === "string" && declared.trim()) {
      return { tier, model: declared.trim(), downgraded: tier !== request.tier,
        reason: tier === request.tier ? "tier_available" : "downgraded_to_available_tier" };
    }
  }
  return { tier: request.tier, model: null, downgraded: false, reason: `host_default:${host}` };
}
