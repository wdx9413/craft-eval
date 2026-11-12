import type { JsonObject } from 'craft-common-store-local';

/**
 * G3: failure attribution.
 *
 * The gap this closes. Craft's receipts already carry per-memory `reason`,
 * `omitted_count` and `retrieval_mode`, and v0.12.36 now produces a
 * deterministic verdict — so the *raw material* for diagnosis exists. What was
 * missing was the layer that turns those observations into a named conclusion.
 * Without it, "the agent got it wrong" is a single undifferentiated fact, and a
 * lesson drawn from it cannot be checked against the cause it claims.
 *
 * The taxonomy is taken from the Eywa memory report (2026), which argues that a
 * single end-to-end score cannot distinguish which layer failed: a wrong answer
 * may come from missing evidence, unsupported extraction, stale state, retrieval
 * loss, or the answer model itself. Each of those needs a different fix, so
 * conflating them makes the failure unlearnable.
 *
 * The rule that shapes this whole module: **attribution is derived from
 * observations, never asserted.** A caller supplies what was observed, and the
 * module either names a cause that the observations support or returns
 * `unattributed`. Guessing a plausible cause is worse than admitting ignorance,
 * because a wrong cause produces a confident, useless, and permanently repeated
 * lesson.
 */

/**
 * Failure classes, ordered by pipeline position rather than alphabetically, so
 * the list reads as the path a fact travels from source to answer.
 */
export const FAILURE_CLASSES = [
  /**
   * The claimed memory was already present in the current turn's own input.
   *
   * Checked first because it invalidates the others: if the evidence is circular,
   * every downstream observation about retrieval and grounding is uninterpretable.
   * This is the contamination that makes a system look like it remembers when it
   * is only repeating what it was just told, and it is dangerous precisely because
   * the answer looks fine — nothing is wrong with the reply, only with the claim
   * that a memory was used.
   */
  "echo_gap",
  /** The source never contained the answer. No retrieval fix can help. */
  "coverage_gap",
  /** The passage was retrieved, but no supported fact was drawn from it. */
  "grounding_gap",
  /** A newer correction existed; stale state was used instead. */
  "revision_gap",
  /** A fact about someone or something else was applied. */
  "scope_gap",
  /** The right fact existed but the time window selected wrongly. */
  "temporal_gap",
  /** The fact existed and was relevant, but was not retrieved or was evicted. */
  "retrieval_gap",
  /** Correct evidence was supplied and the answer was still wrong. */
  "synthesis_gap",
  /** The last resort: nothing observed distinguishes the causes. */
  "unattributed"
] as const;

export type FailureClass = typeof FAILURE_CLASSES[number];

/** Everything the caller observed about one failed turn. */
export interface AttributionObservation {
  /** Was the "remembered" content already present verbatim in the current input? */
  evidence_already_in_input: boolean | null;
  /** Did the source corpus contain the answer at all? */
  source_contained_answer: boolean | null;
  /** Was a supporting passage actually retrieved into context? */
  relevant_retrieved: boolean | null;
  /** Was the answer technically present in the retrieved context? */
  answer_in_context: boolean | null;
  /** Did extraction produce a fact, or only find raw text? */
  fact_extracted: boolean | null;
  /** Did a superseding correction exist that should have won? */
  superseded_by_newer: boolean | null;
  /** Did the applied fact belong to a different scope/entity/person? */
  wrong_scope_applied: boolean | null;
  /** Did the applied fact belong to a different time window? */
  wrong_time_applied: boolean | null;
  /** Was the answer wrong despite complete, correct context? */
  answer_wrong_with_full_context: boolean | null;
}

function flag(input: JsonObject, name: string): boolean | null {
  const value = input[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

/**
 * Attribute one failure to a class.
 *
 * The order is **diagnostic priority, not severity**: causes are checked
 * earliest-in-the-pipeline first, because a fact that was never in the source
 * cannot also have been mis-scoped, and naming the downstream cause would send
 * the fix to the wrong layer. That is the entire value of the taxonomy — one
 * cause, the right one.
 *
 * `null` means "not observed", which is different from `false` ("observed, and
 * it was not the case"). An unobserved signal can never justify a conclusion.
 */
export function attributeFailure(input: JsonObject): JsonObject {
  const observed: AttributionObservation = {
    evidence_already_in_input: flag(input, "evidence_already_in_input"),
    source_contained_answer: flag(input, "source_contained_answer"),
    relevant_retrieved: flag(input, "relevant_retrieved"),
    answer_in_context: flag(input, "answer_in_context"),
    fact_extracted: flag(input, "fact_extracted"),
    superseded_by_newer: flag(input, "superseded_by_newer"),
    wrong_scope_applied: flag(input, "wrong_scope_applied"),
    wrong_time_applied: flag(input, "wrong_time_applied"),
    answer_wrong_with_full_context: flag(input, "answer_wrong_with_full_context")
  };

  const signals: string[] = [];
  const signalsFor = (entries: Array<[string, boolean | null]>): string[] =>
    entries.filter(([, value]) => value !== null).map(([name]) => name);

  let failureClass: FailureClass;
  let remedy: string;

  if (observed.evidence_already_in_input === true) {
    // Checked before everything else: with circular evidence there is no way to
    // trust any downstream conclusion, so naming a retrieval or grounding cause
    // would be describing a pipeline stage that never legitimately ran.
    failureClass = "echo_gap";
    remedy = "the claimed memory was already in the current input; this turn demonstrates echoing, not recall";
    signals.push("evidence_already_in_input");
  } else if (observed.source_contained_answer === false) {
    failureClass = "coverage_gap";
    remedy = "acquire the source document; retrieval tuning cannot fix an absent answer";
    signals.push(...signalsFor([["source_contained_answer", observed.source_contained_answer]]));
  } else if (observed.superseded_by_newer === true) {
    // Checked before retrieval: recalling the right fact and then ignoring that
    // it was superseded is a revision failure, not a search failure.
    failureClass = "revision_gap";
    remedy = "prefer the newest superseding fact and mark the older one inactive";
    signals.push("superseded_by_newer");
  } else if (observed.wrong_scope_applied === true) {
    failureClass = "scope_gap";
    remedy = "constrain retrieval to the requested scope and entity";
    signals.push("wrong_scope_applied");
  } else if (observed.wrong_time_applied === true) {
    failureClass = "temporal_gap";
    remedy = "apply the requested time window during selection, not after";
    signals.push("wrong_time_applied");
  } else if (observed.relevant_retrieved === false) {
    failureClass = "retrieval_gap";
    remedy = "the fact exists but was not retrieved; widen recall or raise its rank";
    signals.push("relevant_retrieved");
  } else if (observed.answer_in_context === false) {
    // Retrieved, but the answer itself never made it into the window: a budget
    // or eviction failure rather than a search failure.
    failureClass = "retrieval_gap";
    remedy = "the answer was dropped between retrieval and context; check the budget and eviction order";
    signals.push("answer_in_context");
  } else if (observed.fact_extracted === false) {
    failureClass = "grounding_gap";
    remedy = "the passage was present but yielded no supported fact; strengthen extraction";
    signals.push("fact_extracted");
  } else if (observed.answer_wrong_with_full_context === true) {
    failureClass = "synthesis_gap";
    remedy = "evidence was complete and correct, so the answer layer is at fault";
    signals.push("answer_wrong_with_full_context");
  } else {
    failureClass = "unattributed";
    remedy = "insufficient observations to name a cause";
  }

  return {
    failure_class: failureClass,
    // The single most important field: a consumer must be able to tell a
    // diagnosis from an admission of ignorance.
    attributed: failureClass !== "unattributed",
    remedy,
    observed_signals: signals.sort(),
    // Counted so a caller can see how much of the picture was actually
    // observed; one signal is a much weaker diagnosis than six.
    observed_count: signalsFor(Object.entries(observed) as Array<[string, boolean | null]>).length,
    total_signals: Object.keys(observed).length
  };
}

/**
 * Attribute a whole set of failures and summarise where the system is weakest.
 *
 * The summary exists because individual attributions answer "what went wrong
 * here", while the aggregate answers "what should we fix first" — and those are
 * different questions. Sorting is by count then by class, so the ranking is
 * stable across runs.
 */
export function summarizeAttributions(input: JsonObject): JsonObject {
  const raw = input.failures;
  if (!Array.isArray(raw) || !raw.length) throw new Error("failures must be a non-empty array");
  const attributions = raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`failures[${index}] must be an object`);
    return attributeFailure(item as JsonObject);
  });

  const counts = new Map<string, number>();
  for (const attribution of attributions) {
    const name = String(attribution.failure_class);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ranking = [...counts.entries()]
    .map(([failure_class, count]) => ({ failure_class, count }))
    .sort((left, right) => right.count - left.count || left.failure_class.localeCompare(right.failure_class));

  const attributed = attributions.filter((item) => item.attributed === true).length;
  return {
    total: attributions.length,
    attributed,
    // Surfaced rather than buried: a falling attribution rate means the
    // observability is degrading, which is itself a finding.
    unattributed_count: attributions.length - attributed,
    ranking,
    // The class to fix first, or null when nothing could be named.
    primary: ranking.length && ranking[0]!.failure_class !== "unattributed" ? ranking[0]!.failure_class : null,
    classes: FAILURE_CLASSES
  };
}
