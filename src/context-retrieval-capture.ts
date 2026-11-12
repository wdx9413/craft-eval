import type { JsonObject } from 'craft-common-store-local';
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";
import { compact, compactWithPromotion } from "./compaction.ts";

/**
 * v0.12.34 ideal-state gap closure.
 *
 * Three gaps were identified by comparing Craft against first-party industry
 * sources (notably Anthropic's Managed Agents post, 2026-04-08, and the
 * Contextual Retrieval post, 2024-09-19). Each was a *shape* problem, not a
 * missing capability:
 *
 *  1. Context management could only truncate. `truncateToBudget` is one-way:
 *     once tokens are gone they cannot come back. Managed Agents calls this out
 *     directly — "irreversible decisions to selectively retain or discard
 *     context can lead to failures. It is difficult to know which tokens the
 *     future turns will need." This module adds a *reversible* context object:
 *     the original is retained and only the *projection* shrinks.
 *
 *  2. Lexical retrieval had no IDF weighting and no identifier awareness. Craft
 *     stores digests, ticket ids and record kinds — exactly the content an
 *     embedding model is worst at. Contextual Retrieval reports contextual
 *     embeddings + contextual BM25 cutting failed retrievals by 49%, and 67%
 *     with reranking. This adds BM25 with an exact-identifier boost.
 *
 *  3. Memory and experience could only be written by an explicit tool call, so
 *     learning depended on the model choosing to remember. This adds a
 *     deterministic, auditable capture path with a confidence gate, so a lesson
 *     survives a session even when the model never asks to store it.
 *
 * Nothing here calls a model or a tokenizer, for the same reason token-budget.ts
 * does not: the decisions must be reproducible on any platform.
 */





// ---------------------------------------------------------------------------
// Gap 1: reversible context
// ---------------------------------------------------------------------------

/**
 * A context window whose original is never destroyed.
 *
 * The distinction that matters: `truncateToBudget` returns a *new shorter
 * string* and the head of the original is unrecoverable. A ReversibleContext
 * keeps every segment, records which ones the current projection omits, and can
 * restore them later. Dropping context becomes a *view* decision rather than a
 * destructive one, so a later turn that turns out to need an earlier segment can
 * still get it.
 */
export interface ContextSegment {
  id: string;
  role: string;
  content: string;
  /** Higher is kept longer when the projection must shrink. */
  weight: number;
  tokens: number;
}

export interface ContextProjection {
  segments: ContextSegment[];
  omitted: string[];
  tokens: number;
  complete: boolean;
}

export class ReversibleContext {
  readonly #segments: ContextSegment[] = [];
  readonly #estimate: (value: string) => number;

  constructor(estimate: (value: string) => number) {
    if (typeof estimate !== "function") throw new Error("ReversibleContext requires a token estimator");
    this.#estimate = estimate;
  }

  append(id: string, role: string, content: string, weight = 1): ContextSegment {
    const segmentId = text(id, "id");
    if (this.#segments.some((segment) => segment.id === segmentId)) throw new Error(`Context segment ${segmentId} already exists`);
    text(content, "content");
    if (!Number.isFinite(weight) || weight < 0) throw new Error("Context segment weight must be a non-negative number");
    const segment: ContextSegment = { id: segmentId, role: text(role, "role"), content, weight, tokens: this.#estimate(content) };
    this.#segments.push(segment);
    return segment;
  }

  get size(): number { return this.#segments.length; }

  get totalTokens(): number { return this.#segments.reduce((sum, segment) => sum + segment.tokens, 0); }

  /** Everything, in insertion order. Nothing here is ever lost. */
  original(): ContextSegment[] { return [...this.#segments]; }

  /**
   * Projects the context into a token budget.
   *
   * The selection is `compact()`'s, not this class's: weight descending, then the more recent
   * segment, then id. It used to be a second implementation of the same ranking, which is how it
   * came to disagree with `compactionPlan` about the tie-break. Deterministic either way — the same
   * inputs always produce the same projection — and omitted segments are named rather than
   * forgotten, so a caller can ask for one back.
   */
  project(maxTokens: number): ContextProjection {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("Context projection cap must be a positive integer");
    const result = compact({ segments: this.#segments, max_tokens: maxTokens, estimate: this.#estimate });
    const kept = new Set(result.kept);
    const segments = this.#segments.filter((segment) => kept.has(segment.id));
    return {
      segments,
      omitted: this.#segments.filter((segment) => !kept.has(segment.id)).map((segment) => segment.id),
      tokens: result.tokens,
      complete: result.complete,
    };
  }

  /**
   * Restores the projection that contains the named segment, if it fits.
   *
   * The promotion guarantee is `compactWithPromotion`'s: the wanted segment is raised above every
   * other, so the only remaining reason for it to be absent is that it fits nowhere. A fixed bump
   * would make the outcome depend on the weights of unrelated segments, and a restore that returned
   * a projection without the segment would be indistinguishable from one that worked.
   */
  restore(segmentId: string, maxTokens: number): ContextProjection {
    const target = this.#segments.find((segment) => segment.id === text(segmentId, "segment_id"));
    if (!target) throw new Error(`Context segment ${segmentId} does not exist`);
    const current = this.project(maxTokens);
    if (current.segments.some((segment) => segment.id === target.id)) return current;
    const result = compactWithPromotion({ segments: this.#segments, max_tokens: maxTokens, estimate: this.#estimate }, target.id);
    const kept = new Set(result.kept);
    return {
      segments: this.#segments.filter((segment) => kept.has(segment.id)),
      omitted: this.#segments.filter((segment) => !kept.has(segment.id)).map((segment) => segment.id),
      tokens: result.tokens,
      complete: result.complete,
    };
  }

  /** Drops the original — the only destructive operation, and it is explicit. */
  seal(): { digest: string; segments: number; tokens: number } {
    return { digest: digestJson(this.#segments), segments: this.#segments.length, tokens: this.totalTokens };
  }
}

// ---------------------------------------------------------------------------
// Gap 2: BM25 with identifier awareness
// ---------------------------------------------------------------------------

export { Bm25Index } from "craft-common-base/bm25";

/**
 * Reciprocal-rank fusion of several ranked lists.
 *
 * Craft already fuses lexical and semantic results this way inside
 * `catalog.searchHybrid`; this exposes the same rule as a reusable, tested
 * function so a new signal (BM25) joins without reimplementing the fusion.
 */
export function fuseRankings(rankings: Array<Array<{ id: string }>>, k = 60): Array<{ id: string; score: number; sources: number }> {
  if (!Number.isFinite(k) || k <= 0) throw new Error("Fusion k must be a positive number");
  const scores = new Map<string, { score: number; sources: number }>();
  for (const ranking of rankings) {
    ranking.forEach((item, index) => {
      const current = scores.get(item.id) ?? { score: 0, sources: 0 };
      current.score += 1 / (k + index + 1);
      current.sources += 1;
      scores.set(item.id, current);
    });
  }
  return [...scores].map(([id, value]) => ({ id, score: value.score, sources: value.sources }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------------------
// Gap 3: deterministic experience capture
// ---------------------------------------------------------------------------

/**
 * Decides whether a finished turn is worth remembering.
 *
 * The gap was that memory required the model to *choose* to call a memory tool,
 * so a lesson survived only if the model asked. This makes capture a
 * deterministic function of observed facts (outcome, retries, corrections,
 * novelty, explicit signals) with a threshold, so it is auditable and testable
 * rather than dependent on model discretion.
 *
 * It deliberately does not try to be clever: a high score still produces a
 * *candidate* that is recorded with its reasons, not a silent write.
 */
export interface CaptureSignals {
  outcome: "succeeded" | "failed" | "abandoned";
  retries: number;
  corrections: number;
  distinct_tools: number;
  novel: boolean;
  user_explicit: boolean;
  duration_minutes?: number;
}

// A single correction must clear the default threshold (25) on its own: a
// correction encodes both the failure AND its fix, so it is the highest-value
// lesson the runtime ever sees. `failure` alone also clears it, because an
// unexplained failure is still worth a note. One retry, or mere novelty, does
// not — those are ordinary and would drown the store.
const WEIGHTS = { failure: 30, retry: 8, correction: 26, breadth: 3, novelty: 15, explicit: 50 } as const;

export interface CaptureDecision {
  capture: boolean;
  score: number;
  threshold: number;
  reasons: string[];
  kind: "failure_lesson" | "correction" | "working_pattern" | "routine";
  dedupe_key: string;
}

export function decideExperienceCapture(input: JsonObject): CaptureDecision {
  const outcome = String(input.outcome);
  if (!["succeeded", "failed", "abandoned"].includes(outcome)) throw new Error("Capture outcome is unsupported");
  const retries = Number(input.retries ?? 0);
  const corrections = Number(input.corrections ?? 0);
  const distinctTools = Number(input.distinct_tools ?? 0);
  for (const [name, value] of [["retries", retries], ["corrections", corrections], ["distinct_tools", distinctTools]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  const novel = input.novel === true;
  const explicit = input.user_explicit === true;
  const threshold = input.threshold === undefined ? 25 : Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Capture threshold must be a non-negative number");

  const reasons: string[] = [];
  let score = 0;
  if (outcome !== "succeeded") { score += WEIGHTS.failure; reasons.push(`outcome_${outcome}`); }
  if (retries > 0) { score += retries * WEIGHTS.retry; reasons.push(`retries_${retries}`); }
  if (corrections > 0) { score += corrections * WEIGHTS.correction; reasons.push(`corrections_${corrections}`); }
  if (distinctTools > 2) { score += (distinctTools - 2) * WEIGHTS.breadth; reasons.push(`breadth_${distinctTools}`); }
  if (novel) { score += WEIGHTS.novelty; reasons.push("novel_situation"); }
  if (explicit) { score += WEIGHTS.explicit; reasons.push("user_requested"); }

  // Kind is derived, not supplied, so a caller cannot mislabel a lesson.
  const kind = explicit ? "working_pattern"
    : corrections > 0 ? "correction"
      : outcome !== "succeeded" ? "failure_lesson"
        : "routine";

  return {
    capture: score >= threshold,
    score,
    threshold,
    reasons,
    kind,
    // Deterministic so capturing the same experience twice is detectable.
    dedupe_key: digestJson({ outcome, kind, reasons, retries, corrections, distinctTools, novel }),
  };
}

/** Turns an accepted capture into the record a store can persist. */
export function buildExperienceRecord(input: JsonObject): JsonObject {
  const decision = decideExperienceCapture(input);
  if (!decision.capture) throw new Error("Experience did not meet the capture threshold");
  const summary = text(input.summary, "summary");
  const taskId = input.task_id === undefined ? null : text(input.task_id, "task_id");
  return {
    experience_id: String(input.experience_id ?? `exp_${decision.dedupe_key.slice(-24)}`),
    kind: decision.kind,
    scope: input.scope === undefined ? "project" : text(input.scope, "scope"),
    task_id: taskId,
    summary,
    reasons: decision.reasons,
    score: decision.score,
    // Provenance is what separates a captured lesson from a guess.
    provenance: { source: "deterministic_capture", captured_by: "runtime", signals_digest: decision.dedupe_key },
    // Only failures and corrections need a human look: they describe something
    // that went wrong. A user-requested working pattern is already vouched for
    // by the person who asked for it, so gating it behind review would add
    // friction without adding safety.
    requires_review: decision.kind === "failure_lesson" || decision.kind === "correction",
  };
}
