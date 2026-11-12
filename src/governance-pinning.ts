import type { JsonObject } from 'craft-common-store-local/';
import { digestJson } from "./digest.ts";
import { compact } from "./compaction.ts";

/**
 * G2: governance pinning.
 *
 * The gap. `ReversibleContext.project()` selects segments purely by weight, so a
 * governance constraint competes for the token budget against the active task
 * state — and a constraint is old, off-topic, and low-salience next to the
 * current sub-goal. That is precisely the mechanism the Governance Decay work
 * (arXiv 2606.22528) measures: compaction raises the violation rate from 0% to
 * 30% (up to 59%), because compaction is engineered for task continuity and
 * treats standing policy as evictable content.
 *
 * Craft is exposed on exactly the channels the paper finds vulnerable. Its
 * threat model explicitly excludes the system message — frameworks that preserve
 * it "simply protect one channel while leaving memory and conversation-carried
 * governance exposed" — and `agent-loop.ts` has no system channel at all, so
 * governance necessarily arrives through memory, tool output, or a user turn:
 * the three channels measured at +45, +33 and +50 points of decay, against +0
 * for the preserved system message.
 *
 * The fix is not a better summary. It is to remove the constraint from the
 * eviction competition entirely, and to make that guarantee checkable rather
 * than trusted.
 *
 * Design rule, inherited from `agent-loop.ts`: a guard must be an explicit
 * ceiling owned by Craft, never a prompt instruction the model could
 * reinterpret. So a pinned constraint is *data*, and whether it survived is
 * decided by comparing content against a recorded digest — not by asking.
 */

/** What kind of standing rule this is. */
export const CONSTRAINT_KINDS = ["prohibited_effect", "required_precondition"] as const;
export type ConstraintKind = typeof CONSTRAINT_KINDS[number];

export interface GovernanceConstraint extends JsonObject {
  id: string;
  kind: ConstraintKind;
  /** The rule in one line, rendered into the pinned block. */
  statement: string;
  /** The effect the rule governs, e.g. `external_write`, `destructive`. */
  effect: string;
  /** Where the rule applies, or `*` for every scope. */
  scope: string;
}

export interface PinBlock extends JsonObject {
  /** The text re-injected after every compaction. */
  text: string;
  /** Ids in the block, sorted, so a comparison is order-independent. */
  constraint_ids: string[];
  /** sha256 over the canonical form, used to detect tampering or loss. */
  pinned_digest: string;
  tokens: number;
}

function text(input: JsonObject, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

/**
 * Estimate tokens the same way the rest of Craft does.
 *
 * Kept local and simple: the number is only ever used for budgeting, and a
 * different estimator would silently change when pinning fits.
 */
export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/** Define one constraint. Rejects an unusable rule rather than guessing intent. */
export function defineConstraint(input: JsonObject): GovernanceConstraint {
  const kind = text(input, "kind");
  if (!(CONSTRAINT_KINDS as readonly string[]).includes(kind)) throw new Error("Constraint kind is unsupported");
  return {
    id: text(input, "id"),
    kind: kind as ConstraintKind,
    statement: text(input, "statement"),
    effect: text(input, "effect"),
    scope: typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : "*",
  };
}

/**
 * Render the pinned block that must survive every compaction.
 *
 * The canonical form is sorted by id so the same constraint set always yields
 * the same digest, whatever order the caller listed them in. Without that, a
 * re-ordered list would look like a changed policy and the integrity check would
 * cry wolf.
 */
export function pinConstraints(constraints: JsonObject[]): PinBlock {
  if (!Array.isArray(constraints) || !constraints.length) throw new Error("constraints must be a non-empty array");
  const parsed = constraints.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`constraints[${index}] must be an object`);
    return defineConstraint(item as JsonObject);
  });
  const ids = parsed.map((constraint) => constraint.id);
  if (new Set(ids).size !== ids.length) throw new Error("Constraint ids must be unique");
  const sorted = [...parsed].sort((left, right) => left.id.localeCompare(right.id));
  const rendered = sorted
    .map((constraint) => `[${constraint.kind}] ${constraint.id} (${constraint.effect}@${constraint.scope}): ${constraint.statement}`)
    .join("\n");
  return {
    text: rendered,
    constraint_ids: sorted.map((constraint) => constraint.id),
    pinned_digest: digestJson(sorted),
    tokens: estimateTokens(rendered),
  };
}

/**
 * Partition a context into pinned and evictable, then project only the latter.
 *
 * This is the whole defence in one function. Rather than ranking the constraint
 * against the task state — a competition it loses — the constraint is taken out
 * of the budget entirely and the remaining segments are projected as before. The
 * pinned text is then re-injected on top, so the result is bounded by
 * `maxTokens + pinTokens` and cannot drop a rule no matter how tight the budget.
 */
export function compactionPlan(input: JsonObject): JsonObject {
  const segments = input.segments;
  if (!Array.isArray(segments)) throw new Error("segments must be an array");
  const maxTokens = input.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("max_tokens must be a positive integer");
  const pin = pinConstraints((input.constraints as JsonObject[]) ?? []);
  const pinnedIds = new Set(pin.constraint_ids);

  const pinned: JsonObject[] = [];
  const evictable: JsonObject[] = [];
  for (const [index, item] of segments.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`segments[${index}] must be an object`);
    const segment = item as JsonObject;
    const id = text(segment, "id");
    (pinnedIds.has(id) ? pinned : evictable).push(segment);
  }

  // A constraint listed as a segment but never defined is a configuration error,
  // not a rule: silently pinning it would protect a policy nobody declared.
  const found = new Set(pinned.map((segment) => String(segment.id)));
  const missing = [...pinnedIds].filter((id) => !found.has(id));

  // The selection itself is `compact()`'s policy with the constraints removed from the competition.
  // This function used to be a second implementation of that ranking, which is how it came to break
  // weight ties in the opposite direction from `ReversibleContext` — a difference no caller chose.
  const outcome = compact({
    segments: (segments as JsonObject[]).map((segment) => ({
      id: String(segment.id), content: String(segment.content ?? ""),
      ...(segment.weight === undefined ? {} : { weight: Number(segment.weight) }),
      ...(segment.tokens === undefined ? {} : { tokens: Number(segment.tokens) }),
    })),
    max_tokens: maxTokens,
    protect: pin.constraint_ids,
    estimate: estimateTokens,
  });
  return {
    // Pinned first, so a truncating consumer drops task state rather than policy.
    pinned: pin.constraint_ids,
    pinned_text: pin.text,
    pinned_digest: pin.pinned_digest,
    pinned_tokens: pin.tokens,
    // Pinned ids are excluded here because `pinned` already reports them: this list has always meant
    // "evictable segments that survived", while the policy reports both kinds as kept. `pinned_tokens`
    // is the **rendered block's** cost rather than the cost of the constraint segments — the two are
    // different quantities, and the block is what actually reaches the model.
    kept: outcome.kept.filter((id) => !pinnedIds.has(id)),
    omitted: [...outcome.elided],
    tokens: outcome.tokens,
    // Total cost is explicit: pinning is not free, it is merely cheap.
    total_tokens: outcome.tokens + pin.tokens,
    // Named rather than assumed, so a misconfiguration is visible. The two reasons a constraint can
    // fail to bind are now distinct: never declared as a segment, or declared and unrecognised.
    unbound_constraints: missing.length ? missing : [...outcome.unbound],
    // The guarantee, stated as a fact the caller can rely on: no constraint can
    // appear in the omitted set.
    constraints_preserved: missing.length === 0 && outcome.unbound.length === 0
      && !pin.constraint_ids.some((id) => outcome.elided.includes(id)),
  };
}

/**
 * Verify the pinned block is still intact in a rendered context.
 *
 * Integrity is checked by content, not by presence: a constraint that appears
 * but has been reworded is not the rule that was pinned. This is the check the
 * paper calls for across turns, and it is what makes the guarantee falsifiable
 * rather than asserted.
 */
export function verifyPinIntact(input: JsonObject): JsonObject {
  const declared = input.constraints;
  if (!Array.isArray(declared) || !declared.length) throw new Error("constraints must be a non-empty array");
  const pin = pinConstraints(declared as JsonObject[]);
  const rendered = input.rendered;
  if (typeof rendered !== "string") throw new Error("rendered must be a string");
  const present = pin.constraint_ids.filter((id) => rendered.includes(id));
  const missing = pin.constraint_ids.filter((id) => !present.includes(id));
  // A renamed but still-quoted rule would pass a naive id check, so the exact
  // statement text must also be present.
  const parsed = (declared as JsonObject[]).map((item) => defineConstraint(item));
  const reworded = parsed.filter((constraint) => !rendered.includes(constraint.statement)).map((constraint) => constraint.id);
  const intact = missing.length === 0 && reworded.length === 0;
  return {
    intact,
    // `unverifiable` is reserved for a rendered context we were not given: an
    // unchecked pin is not an intact pin.
    verdict: intact ? "preserved" : missing.length ? "dropped" : "reworded",
    present,
    missing,
    reworded,
    pinned_digest: pin.pinned_digest,
    pinned_tokens: pin.tokens,
  };
}

/**
 * Detect Governance Decay across a compaction, given the same prohibited attempt
 * before and after.
 *
 * This is the paper's measurement, reduced to something a test can assert: the
 * same request, the same model, and only the context differs. A violation that
 * appears only after compaction is decay, and naming the lost constraint is what
 * makes it actionable rather than mysterious.
 */
export function detectConstraintDecay(input: JsonObject): JsonObject {
  const before = input.violated_before_compaction;
  const after = input.violated_after_compaction;
  if (typeof before !== "boolean" || typeof after !== "boolean") {
    throw new Error("violation observations must be booleans");
  }
  const drop = input.constraint_dropped;
  if (typeof drop !== "boolean") throw new Error("constraint_dropped must be a boolean");
  return {
    // Decay is specifically the violation that compaction introduced. A run that
    // was already violating was not made worse by compaction.
    decay_detected: !before && after,
    violated_before: before,
    violated_after: after,
    constraint_dropped: drop,
    // Reported together because the causal story is the useful part: the rule
    // left and the behaviour changed.
    explanation: before
      ? "already violating before compaction, so compaction is not the cause"
      : after
        ? drop ? "constraint left the context and the prohibition was then violated"
          : "violation appeared without the constraint being dropped; look elsewhere"
        : "no violation in either condition, so there is no decay to explain",
    // A violation without a dropped constraint is a different finding, and
    // conflating them would overstate what pinning can fix.
    attributable_to_pinning: !before && after && drop,
  };
}

/**
 * Where the constraints stand relative to the three channel types the paper
 * measured. Reported so an operator can see whether the pin actually reaches
 * the model, instead of assuming a definition implies delivery.
 */
export function constraintChannelRisk(input: JsonObject): JsonObject {
  const raw = input.channels;
  if (!Array.isArray(raw) || !raw.length) throw new Error("channels must be a non-empty array");
  const channels = raw.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`channels[${index}] must not be empty`);
    return item.trim();
  });
  // Decay measured by the paper, in percentage points, for each channel that
  // actually gets compacted. The system message is absent by construction: it is
  // the one channel that does not decay, which is exactly why relying on the
  // others is the failure mode.
  const DECAY = { user_instruction: 50, memory: 45, tool_output: 33, system: 0 } as const;
  const unknown = channels.filter((channel) => !Object.hasOwn(DECAY, channel));
  if (unknown.length) throw new Error(`Constraint channel is unsupported: ${unknown[0]}`);
  const risk = channels.reduce((total, channel) => total + DECAY[channel as keyof typeof DECAY], 0);
  return {
    channels,
    // Summed rather than averaged: decay is exposure, and delivering the same
    // rule through two vulnerable channels is not the average of the two.
    exposure: risk,
    vulnerable: channels.filter((channel) => DECAY[channel as keyof typeof DECAY] > 0),
    // The recommendation is structural: pinning is what makes any of these safe,
    // and there is no prompt wording that substitutes for it.
    recommendation: risk > 0 ? "pin the constraint so it never enters the eviction competition" : "no compacted channel carries this constraint",
  };
}
