import type { CraftService } from "./craft-service-interface.ts";
import type { CraftStore } from 'craft-common-store-local';
import { stableDigest } from 'craft-common-base/digest';
import { approvedEffects, executeSteps, normalizeSteps } from 'craft-common-base/workflow';
import { checkRelationConcepts, mapLegacyKind } from 'craft-common-ontology/validation';

type JsonObject = Record<string, unknown>;

/** Minimal conforming shim for evaluation scripting. Every capability method
 * no-ops with a safe default; evaluation cases that need real store writes use
 * `service.store` directly. */
export class CraftServiceShim implements CraftService {
  readonly store: CraftStore;

  constructor(store: CraftStore) {
    this.store = store;
  }

  knowledgeSourceRegister(_args: JsonObject): JsonObject { return {}; }
  memoryLedgerRemember(_args: JsonObject): JsonObject { return {}; }
  async memorySearch(_args: JsonObject): Promise<JsonObject> { return {}; }
  evidenceRecord(args: JsonObject): JsonObject {
    const evidenceId = String(args.evidence_id ?? `evidence_${stableDigest(args).slice(-24)}`);
    const existing = this.store.find("evidence", evidenceId);
    if (existing) return existing;
    return this.store.create("evidence", evidenceId, { source_type: String(args.source_type ?? "program"),
      claim: String(args.claim ?? ""), confidence: String(args.confidence ?? "bounded"), ...args });
  }

  /**
   * The lineage cases assert over real claims and relations, so the shim must
   * persist a claim the relation endpoint can resolve. It stores the minimum a
   * claim needs to exist as a storage parent; content stays in the caller's
   * object, never in this shim.
   */
  knowledgeClaimSave(args: JsonObject): JsonObject {
    const claimId = String(args.claim_id ?? `knowledge_claim_${stableDigest(args).slice(-24)}`);
    const existing = this.store.find("knowledge_claim", claimId);
    if (existing) return { claim: existing, idempotent: true };
    const legacyKind = String(args.kind ?? "fact");
    const claim = this.store.create("knowledge_claim", claimId, {
      kind: legacyKind, scope: String(args.scope ?? "global"),
      // The real capability maps its legacy kind through the shared taxonomy and
      // persists the concept as non-identity metadata; the shim must do the same
      // so concept-aware evaluation observes the real contract.
      concept_kind: mapLegacyKind("knowledge", legacyKind),
      status: "candidate", source_id: String(args.source_id ?? "builtin.evidence-wiki"),
      content: String(args.content ?? ""), content_digest: stableDigest(String(args.content ?? "")),
      evidence_ids: Array.isArray(args.evidence_ids) ? args.evidence_ids.map(String) : [],
      tags: Array.isArray(args.tags) ? args.tags.map(String) : [], valid_until: null,
      ...(args.title === undefined ? {} : { title: String(args.title) }),
    });
    return { claim, idempotent: false };
  }
  knowledgeAutoReview(_args: JsonObject): JsonObject { return {}; }
  knowledgeClaimGet(_args: JsonObject): JsonObject { return {}; }
  /** Persist a workflow definition; steps are validated by the shared normalizer. */
  workflowSave(args: JsonObject): JsonObject {
    const steps = normalizeSteps(Array.isArray(args.steps) ? args.steps : []);
    const id = String(args.workflow_id ?? `workflow_${stableDigest({ name: args.name, steps }).slice(-24)}`);
    const existing = this.store.find("workflow", id);
    if (existing) return existing;
    return this.store.create("workflow", id, { name: String(args.name ?? id), steps });
  }

  /**
   * Execute a saved workflow against a project root. Approval is read from the
   * caller, never assumed: a step whose effect is not approved fails closed
   * with `side_effect_not_approved`, which is exactly what the approval cases
   * assert.
   */
  workflowRun(args: JsonObject): JsonObject {
    const workflow = this.store.find("workflow", String(args.workflow_id));
    if (!workflow) throw new Error(`Unknown workflow: ${String(args.workflow_id)}`);
    const root = String(args.project_root ?? process.cwd());
    const approved = approvedEffects(args.allow_execution === true, Array.isArray(args.approved_effects) ? args.approved_effects : []);
    const results = executeSteps(workflow.steps as JsonObject[], root, approved);
    return { workflow_id: workflow.id, status: results.every((item) => item.passed === true) ? "passed" : "failed", results };
  }
  modelAdd(_args: JsonObject): JsonObject { return {}; }
  taskOpen(_args: JsonObject): { task: JsonObject } { return { task: {} }; }
  async taskMessageSend(_args: JsonObject): Promise<JsonObject> { return {}; }
  /**
   * Relation and lineage are the two methods the knowledge-lineage cases drive
   * end to end. Stubbing them made those cases report "passed" on empty objects
   * while asserting nothing, so they are implemented here over the same store
   * the rest of the evaluator uses.
   */
  relationSave(args: JsonObject): JsonObject {
    const source = endpoint(args.source, "source");
    const target = endpoint(args.target, "target");
    if (source.kind === target.kind && source.id === target.id) throw new Error("Relation endpoints must differ");
    const relation = String(args.relation ?? "");
    if (!new Set(["derives_from", "contradicts", "supersedes", "supports", "refines"]).has(relation)) throw new Error("Knowledge relation is unsupported");
    const confidence = String(args.confidence ?? "bounded");
    if (!new Set(["confirmed", "bounded", "speculative"]).has(confidence)) throw new Error("Relation confidence is unsupported");
    const evidenceIds = Array.isArray(args.evidence_ids) ? args.evidence_ids.map(String) : [];
    if (confidence === "confirmed" && !evidenceIds.length) throw new Error("Confirmed Knowledge Relation requires Evidence");
    const identity = { source, target, relation, evidence_ids: evidenceIds, confidence };
    const relationId = String(args.relation_id ?? `knowledge_relation_${stableDigest(identity).slice(-32)}`);
    const existing = this.store.find("knowledge_relation", relationId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Knowledge Relation idempotency conflict");
      return { relation: existing, idempotent: true };
    }
    return { relation: this.store.create("knowledge_relation", relationId, { ...identity,
      identity_digest: stableDigest(identity), valid_from: String(args.valid_from ?? new Date().toISOString()), valid_to: null }), idempotent: false };
  }

  knowledgeLineageImpact(args: JsonObject): JsonObject {
    const root = endpoint(args.node, "node");
    const relations = this.store.list("knowledge_relation", 10_000) as JsonObject[];
    const live = relations.filter((item) => item.valid_to === null || item.valid_to === undefined);
    const same = (left: JsonObject, right: JsonObject) => String(left.kind) === String(right.kind) && String(left.id) === String(right.id);
    const conceptOf = (node: JsonObject): string | null => {
      try {
        const record = this.store.get(String(node.kind), String(node.id));
        return typeof record.concept_kind === "string" ? record.concept_kind : null;
      } catch { return null; }
    };
    const typeIssues: JsonObject[] = [];
    for (const edge of live) {
      const check = checkRelationConcepts(edge.relation, conceptOf(edge.source as JsonObject), conceptOf(edge.target as JsonObject));
      if (!check.valid && check.reason) typeIssues.push({ relation_id: String(edge.id), relation: String(edge.relation), reason: check.reason });
    }
    const challengeIds = live.filter((item) => (item.relation === "contradicts" || item.relation === "supersedes")
      && same(item.target as JsonObject, root)).map((item) => String(item.id)).sort();
    const rootChallenged = challengeIds.length > 0;
    const impacted: JsonObject[] = [];
    const visited = new Set([`${String(root.kind)}:${String(root.id)}`]);
    let frontier: Array<{ node: JsonObject; depth: number; factor: number; via: string | null; confidence: string | null }> = [{ node: root, depth: 0, factor: 1, via: null, confidence: null }];
    for (let depth = 1; depth <= 8 && frontier.length; depth += 1) {
      const next: typeof frontier = [];
      for (const entry of frontier) {
        for (const edge of live) {
          if (edge.relation !== "derives_from" || !same(edge.target as JsonObject, entry.node)) continue;
          const derived = edge.source as JsonObject;
          const key = `${String(derived.kind)}:${String(derived.id)}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const confidence = String(edge.confidence ?? "bounded");
          const factor = Number((entry.factor * (confidence === "confirmed" ? 1 : confidence === "bounded" ? 0.8 : 0.5)).toFixed(2));
          const row = { node: { kind: derived.kind, id: derived.id, version: null }, depth, confidence_factor: factor,
            via_relation_id: String(edge.id), relation_confidence: confidence, needs_reevaluation: rootChallenged };
          impacted.push(row);
          next.push({ node: derived, depth, factor, via: String(edge.id), confidence });
        }
      }
      frontier = next;
    }
    return { root, root_challenged: rootChallenged, challenge_relation_ids: challengeIds, impacted,
      truncated: false, needs_reevaluation: rootChallenged && impacted.length > 0, type_issues: typeIssues };
  }
}

function endpoint(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const item = value as JsonObject;
  const kind = String(item.kind ?? ""); const id = String(item.id ?? "");
  if (!kind || !id) throw new Error(`${name} requires kind and id`);
  return { kind, id };
}
