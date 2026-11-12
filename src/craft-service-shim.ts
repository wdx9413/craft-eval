import type { CraftService } from "./craft-service-interface.ts";
import type { CraftStore } from 'craft-common-store-local/';

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
  evidenceRecord(_args: JsonObject): JsonObject { return {}; }
  knowledgeClaimSave(_args: JsonObject): JsonObject { return {}; }
  knowledgeAutoReview(_args: JsonObject): JsonObject { return {}; }
  knowledgeClaimGet(_args: JsonObject): JsonObject { return {}; }
  workflowSave(_args: JsonObject): JsonObject { return {}; }
  workflowRun(_args: JsonObject): JsonObject { return {}; }
  modelAdd(_args: JsonObject): JsonObject { return {}; }
  taskOpen(_args: JsonObject): { task: JsonObject } { return { task: {} }; }
  async taskMessageSend(_args: JsonObject): Promise<JsonObject> { return {}; }
  relationSave(_args: JsonObject): JsonObject { return {}; }
  knowledgeLineageImpact(_args: JsonObject): JsonObject { return {}; }
}
