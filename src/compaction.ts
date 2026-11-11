import { digestJson } from "./digest.ts";
import { estimateTokens } from "./token-budget.ts";

/**
 * The one compaction policy.
 *
 * Craft had **three** mechanisms that answered "what fits in the budget", written independently and
 * unaware of each other:
 *
 * | mechanism | where it was | its rule |
 * |---|---|---|
 * | `compactConversation` | `runtime-truth.ts` | keep the first system message and a **contiguous recent suffix** up to 65% of the budget, elide the middle |
 * | `ReversibleContext` | `context-retrieval-capture.ts` | rank by **weight, then recency**, drop whole segments, report the omitted ids so one can come back |
 * | `compactionPlan` | `governance-pinning.ts` | take **constraints out of the competition** entirely, then rank the rest by weight |
 *
 * They disagreed where it mattered and agreed where it did not: two of them ranked by weight but
 * broke ties in **opposite** directions, and only one of them protected anything. A caller's result
 * therefore depended on which function it happened to call rather than on a policy anyone had
 * chosen. This module is that policy, and the three entry points are now adapters over it.
 *
 * ### The two stages, and why they are not one
 *
 * 1. **Reservation** (`tail_share`): a *contiguous* suffix is kept first. Contiguity is the point —
 *    a conversation's middle must be a contiguous run for the elided span to be summarisable at
 *    all, so this stage stops at the first segment that does not fit rather than skipping it. This
 *    is what `compactConversation` always did, and it is the correct rule for a transcript.
 * 2. **Competition** (`weight`): the remainder is ranked and packed, **skipping** a segment that
 *    does not fit and trying the next. That packs a budget better and is what both
 *    segment-selection callers did.
 *
 * Two stages with different fill rules is not an inconsistency to be tidied away; a transcript and
 * a bag of retrievable segments are asking different questions. What *was* an inconsistency is the
 * tie-break, and it is now single: **weight descending, then the more recent segment first, then id
 * ascending.** Preferring the recent segment is the defensible default for both callers — the
 * current sub-goal over an older one — and it changed `compactionPlan`'s output for weight-tied
 * segments, which its test records.
 *
 * ### Protection is subtraction, not a higher weight
 *
 * `protect` removes a segment from the budget **and from the omitted set**. Giving a constraint a
 * large weight would still lose to a tighter budget, which is exactly the failure the governance
 * research measures: compaction is engineered for task continuity and treats standing policy as
 * evictable content. So a protected segment's cost is reported **separately** (`protected_tokens`,
 * `total_tokens`) rather than charged against `max_tokens`, and `unbound` names a protected id that
 * no segment matched — a misconfiguration is reported rather than silently protecting nothing.
 *
 * ### The summariser is optional and its fallback is deterministic
 *
 * `summarize` is called only when something was elided. Without it the policy produces a note that
 * is content-free and reproducible, carrying the digest of what it replaced, so "compact" is
 * always decidable without a model and only the *quality* of the note varies with one.
 */

export interface CompactionSegment {
  readonly id: string;
  readonly role?: string;
  readonly content: string;
  /** Higher is kept longer when the budget is contested. Defaults to `1`. */
  readonly weight?: number;
  /** Pre-computed cost. Estimated from `content` when absent, so callers may pass either. */
  readonly tokens?: number;
}

export interface CompactionRequest {
  readonly segments: readonly CompactionSegment[];
  readonly max_tokens: number;
  /** Token estimator. Defaults to the one the rest of Craft budgets with. */
  readonly estimate?: (value: string) => number;
  /** Ids removed from the competition entirely. An id matching no segment is reported `unbound`. */
  readonly protect?: readonly string[];
  /**
   * Share of the budget reserved for a contiguous recent suffix, `0 < share <= 1`. `0` disables the
   * stage, which is what a caller selecting a bag of segments wants.
   */
  readonly tail_share?: number;
  readonly summarize?: (elided: readonly CompactionSegment[]) => string;
}

export interface CompactionResult {
  /** Ids kept, in the input's order — a projection, not a reordering. */
  readonly kept: readonly string[];
  /** Ids elided, in the input's order. */
  readonly elided: readonly string[];
  readonly protected_ids: readonly string[];
  /** Protected ids no segment matched. Non-empty means the caller's policy is misconfigured. */
  readonly unbound: readonly string[];
  readonly tokens: number;
  readonly protected_tokens: number;
  /** `tokens + protected_tokens`. Pinning is cheap, not free, and this says which. */
  readonly total_tokens: number;
  /** The note replacing the elided span, or `null` when nothing was elided or no summariser ran. */
  readonly summary: string | null;
  readonly complete: boolean;
  /** True when the result is what the input already was, so a caller can skip a rewrite. */
  readonly unchanged: boolean;
}

/** The digest of an elided span, for the deterministic fallback note. */
function digestOf(segments: readonly CompactionSegment[]): string {
  return digestJson(segments.map((segment) => ({ id: segment.id, role: segment.role ?? null, content: segment.content })));
}

export function compact(request: CompactionRequest): CompactionResult {
  const estimate = request.estimate ?? estimateTokens;
  if (typeof estimate !== "function") throw new Error("compaction requires a token estimator");
  if (!Number.isInteger(request.max_tokens) || request.max_tokens < 1) throw new Error("max_tokens must be a positive integer");
  const share = request.tail_share ?? 0;
  if (!Number.isFinite(share) || share < 0 || share > 1) throw new Error("tail_share must be between 0 and 1");
  if (!Array.isArray(request.segments)) throw new Error("segments must be an array");

  const cost = (segment: CompactionSegment): number => {
    const value = segment.tokens ?? estimate(String(segment.content ?? ""));
    if (!Number.isFinite(value) || value < 0) throw new Error(`segment ${segment.id} has an invalid token cost`);
    return value;
  };
  const ids = request.segments.map((segment) => String(segment.id));
  if (new Set(ids).size !== ids.length) throw new Error("segment ids must be unique");

  // --- Stage 0: protection, by subtraction ------------------------------------------------
  const protectedIds = new Set(request.protect ?? []);
  const protectedSegments = request.segments.filter((segment) => protectedIds.has(String(segment.id)));
  const matched = new Set(protectedSegments.map((segment) => String(segment.id)));
  const unbound = [...protectedIds].filter((id) => !matched.has(id)).sort();
  const protectedTokens = protectedSegments.reduce((sum, segment) => sum + cost(segment), 0);
  let evictable = request.segments.filter((segment) => !protectedIds.has(String(segment.id)));

  // --- Stage 1: a contiguous recent suffix ------------------------------------------------
  const kept = new Set<string>();
  let tokens = 0;
  if (share > 0 && evictable.length) {
    const ceiling = Math.floor(request.max_tokens * share);
    const reserved: CompactionSegment[] = [];
    // From the end backwards, stopping at the first that does not fit. Contiguity is what makes the
    // elided span a single run the summariser can describe, and it is why this stage does not skip.
    for (let index = evictable.length - 1; index >= 0; index -= 1) {
      const segment = evictable[index]!;
      const value = cost(segment);
      if (tokens + value > ceiling) break;
      reserved.unshift(segment);
      tokens += value;
      kept.add(String(segment.id));
    }
    const reservedIds = new Set(reserved.map((segment) => String(segment.id)));
    evictable = evictable.filter((segment) => !reservedIds.has(String(segment.id)));
  }

  // --- Stage 2: competition for what is left ---------------------------------------------
  // One tie-break for the whole system: weight, then recency. The recency term used to point the
  // other way in `compactionPlan`, which meant two weight-tied segments were ordered by which
  // function you called.
  //
  // There is deliberately no third term on id, and no `??` on the position lookup. Every evictable
  // segment is one of `request.segments`, whose ids are required to be unique, so each has a
  // position and weight-plus-recency is already a total order. A fallback there would be
  // unreachable, and an unreachable branch reads as a rule that exists.
  const position = new Map(request.segments.map((segment, index) => [String(segment.id), index]));
  const ranked = [...evictable].sort((left, right) =>
    (right.weight ?? 1) - (left.weight ?? 1)
    || position.get(String(right.id))! - position.get(String(left.id))!);
  for (const segment of ranked) {
    const value = cost(segment);
    // Skip rather than stop: a segment that does not fit should not exclude every smaller one after
    // it, which is the difference between packing a budget and giving up on it.
    if (tokens + value > request.max_tokens) continue;
    kept.add(String(segment.id));
    tokens += value;
  }

  // A protected segment **is** kept — protection removes it from the competition, not from the
  // result. An earlier version reported it only in `protected_ids`, which made every caller that
  // asked "was this kept?" get `false` for the one segment the guarantee was about.
  const keptIds = request.segments
    .filter((segment) => kept.has(String(segment.id)) || protectedIds.has(String(segment.id)))
    .map((segment) => String(segment.id));
  const keptSet = new Set(keptIds);
  const elidedIds = request.segments.filter((segment) => !keptSet.has(String(segment.id))).map((segment) => String(segment.id));
  const elided = request.segments.filter((segment) => !keptSet.has(String(segment.id)));
  const summary = elided.length === 0 ? null
    : request.summarize ? request.summarize(elided)
      : `Compacted ${elided.length} earlier segment(s); retain only their digest for replay: ${digestOf(elided)}`;

  return {
    kept: keptIds,
    elided: elidedIds,
    protected_ids: protectedSegments.map((segment) => String(segment.id)),
    unbound,
    tokens,
    protected_tokens: protectedTokens,
    total_tokens: tokens + protectedTokens,
    summary,
    complete: elided.length === 0,
    unchanged: elided.length === 0,
  };
}

/**
 * The projection a caller should use when a segment must be brought back.
 *
 * `compact` answers "what fits"; this answers "what fits *given that* this one must". It is a
 * separate function because the guarantee is different: instead of protecting a segment by
 * subtraction, it **promotes** the wanted segment above every other, so the only remaining reason
 * for it to be absent is that it does not fit at all. A fixed bump would make the outcome depend on
 * the weights of unrelated segments, which is not a guarantee anyone can reason about.
 *
 * Throws when the segment does not fit, because a restore that silently returned a projection
 * without it would be indistinguishable from one that worked.
 */
export function compactWithPromotion(request: CompactionRequest, promoteId: string): CompactionResult {
  const target = request.segments.find((segment) => String(segment.id) === promoteId);
  if (!target) throw new Error(`Context segment ${promoteId} does not exist`);
  const ceiling = Math.max(0, ...request.segments.map((segment) => segment.weight ?? 1));
  const promoted: CompactionRequest = {
    ...request,
    segments: request.segments.map((segment) =>
      String(segment.id) === promoteId ? { ...segment, weight: ceiling + 1 } : segment),
  };
  const result = compact(promoted);
  if (!result.kept.includes(promoteId)) {
    throw new Error(`Context segment ${promoteId} cannot be restored within ${request.max_tokens} tokens`);
  }
  return result;
}
