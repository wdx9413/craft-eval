import type { CraftStore } from '../../craft-common/packages/craft-common-store-local/src/store.ts';

type JsonObject = Record<string, unknown>;

export interface CraftService {
  readonly store: CraftStore;

  knowledgeSourceRegister(args: JsonObject): JsonObject;
  memoryLedgerRemember(args: JsonObject): JsonObject;
  memorySearch(args: JsonObject): Promise<JsonObject>;
  evidenceRecord(args: JsonObject): JsonObject;
  knowledgeClaimSave(args: JsonObject): JsonObject;
  knowledgeAutoReview(args: JsonObject): JsonObject;
  knowledgeClaimGet(args: JsonObject): JsonObject;
  workflowSave(args: JsonObject): JsonObject;
  workflowRun(args: JsonObject): JsonObject;
  modelAdd(args: JsonObject): JsonObject;
  taskOpen(args: JsonObject): { task: JsonObject };
  taskMessageSend(args: JsonObject): Promise<JsonObject>;
  relationSave(args: JsonObject): JsonObject;
  knowledgeLineageImpact(args: JsonObject): JsonObject;
}
