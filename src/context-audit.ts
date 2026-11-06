import { createHash } from 'node:crypto';

export type ContextMember = 'knowledge' | 'memory' | 'experience' | 'codebase' | 'history' | 'state' | 'host';
export interface ContextAuditReference { member: ContextMember; id: string; version?: number }
export interface ContextAuditManifest {
  schema: 'craft-eval.context-audit.v1';
  case_id: string;
  required_refs?: ContextAuditReference[];
  forbidden_refs?: ContextAuditReference[];
  allowed_refs?: ContextAuditReference[];
  max_items?: number;
  max_chars?: number;
  max_estimated_tokens?: number;
  reference_only_members?: ContextMember[];
  require_host_token_measurement?: boolean;
}
export interface ContextAuditCheck { id: string; status: 'passed' | 'failed' | 'inconclusive'; observed: number | boolean | null; expected: number | boolean | null }
export interface ContextAuditReport {
  schema: 'craft-eval.context-audit-report.v1'; case_id: string; status: 'passed' | 'failed' | 'inconclusive'; pack_sha256: string; expectations_sha256: string;
  metrics: { selected_ref_count: number; selected_item_count: number; selected_chars: number; estimated_tokens: number | null; host_measured_tokens: number | null; required_ref_recall: number | null; forbidden_ref_count: number; duplicate_ref_count: number };
  checks: ContextAuditCheck[]; partial: boolean;
  limitations: string[];
}

const MEMBERS = new Set<ContextMember>(['knowledge', 'memory', 'experience', 'codebase', 'history', 'state', 'host']);
const BODY_FIELDS = ['content', 'content_excerpt', 'text', 'body', 'source', 'source_text', 'code', 'snippet'];
const MAX_INPUT_BYTES = 1_000_000;

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const result = nonNegativeInteger(value, name);
  if (result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}

function parseReference(value: unknown, name: string): ContextAuditReference {
  const ref = object(value, name);
  if (typeof ref.member !== 'string' || !MEMBERS.has(ref.member as ContextMember)) throw new Error(`${name}.member is invalid`);
  if (typeof ref.id !== 'string' || ref.id.trim() === '' || ref.id.length > 512) throw new Error(`${name}.id is invalid`);
  if (ref.version !== undefined) positiveInteger(ref.version, `${name}.version`);
  return { member: ref.member as ContextMember, id: ref.id, ...(ref.version === undefined ? {} : { version: ref.version as number }) };
}

function referenceList(value: unknown, name: string): ContextAuditReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`${name} must be an array of at most 10000 references`);
  return value.map((item, index) => parseReference(item, `${name}[${index}]`));
}

function bounded(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const result = positiveInteger(value, name);
  if (result > MAX_INPUT_BYTES) throw new Error(`${name} exceeds ${MAX_INPUT_BYTES}`);
  return result;
}

type ValidatedManifest = Omit<ContextAuditManifest, 'required_refs' | 'forbidden_refs' | 'allowed_refs' | 'reference_only_members'> & {
  required_refs: ContextAuditReference[]; forbidden_refs: ContextAuditReference[]; allowed_refs: ContextAuditReference[]; reference_only_members: ContextMember[];
};

function validateManifest(value: unknown): ValidatedManifest {
  const input = object(value, 'manifest');
  const allowed = new Set(['schema', 'case_id', 'required_refs', 'forbidden_refs', 'allowed_refs', 'max_items', 'max_chars', 'max_estimated_tokens', 'reference_only_members', 'require_host_token_measurement']);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`manifest contains unsupported field: ${unknown}`);
  if (input.schema !== 'craft-eval.context-audit.v1') throw new Error('manifest.schema must be craft-eval.context-audit.v1');
  if (typeof input.case_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.case_id)) throw new Error('manifest.case_id is invalid');
  const required_refs = referenceList(input.required_refs, 'manifest.required_refs');
  const forbidden_refs = referenceList(input.forbidden_refs, 'manifest.forbidden_refs');
  const allowed_refs = referenceList(input.allowed_refs, 'manifest.allowed_refs');
  const intersects = (left: ContextAuditReference, right: ContextAuditReference) => left.member === right.member && left.id === right.id && (left.version === undefined || right.version === undefined || left.version === right.version);
  if (required_refs.some(required => forbidden_refs.some(forbidden => intersects(required, forbidden)))) throw new Error('manifest marks a reference as both required and forbidden');
  if (allowed_refs.length > 0 && required_refs.some(required => !allowed_refs.some(allowed => intersects(required, allowed)))) throw new Error('manifest.required_refs must be included in allowed_refs');
  for (const [name, list] of [['required_refs', required_refs], ['forbidden_refs', forbidden_refs], ['allowed_refs', allowed_refs]] as const) {
    if (list.some((item, index) => list.slice(0, index).some(previous => intersects(item, previous)))) throw new Error(`manifest.${name} contains duplicate or conflicting references`);
  }
  const reference_only_members = input.reference_only_members === undefined ? [] : input.reference_only_members;
  if (!Array.isArray(reference_only_members) || reference_only_members.some(member => typeof member !== 'string' || !MEMBERS.has(member as ContextMember))) throw new Error('manifest.reference_only_members is invalid');
  if (input.require_host_token_measurement !== undefined && typeof input.require_host_token_measurement !== 'boolean') throw new Error('manifest.require_host_token_measurement must be boolean');
  const max_items = bounded(input.max_items, 'manifest.max_items');
  const max_chars = bounded(input.max_chars, 'manifest.max_chars');
  const max_estimated_tokens = bounded(input.max_estimated_tokens, 'manifest.max_estimated_tokens');
  if (required_refs.length + forbidden_refs.length + allowed_refs.length + reference_only_members.length === 0 && max_items === undefined && max_chars === undefined && max_estimated_tokens === undefined && input.require_host_token_measurement !== true) {
    throw new Error('manifest must define at least one reference or budget assertion');
  }
  return { schema: 'craft-eval.context-audit.v1', case_id: input.case_id, required_refs, forbidden_refs, allowed_refs,
    ...(max_items === undefined ? {} : { max_items }), ...(max_chars === undefined ? {} : { max_chars }),
    ...(max_estimated_tokens === undefined ? {} : { max_estimated_tokens }), reference_only_members: reference_only_members as ContextMember[],
    ...(input.require_host_token_measurement === undefined ? {} : { require_host_token_measurement: input.require_host_token_measurement }) };
}

function unwrapPack(value: unknown): Record<string, unknown> {
  let candidate = value;
  const outer = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (outer?.structuredContent !== undefined) candidate = outer.structuredContent;
  else if (Array.isArray(outer?.content)) {
    const text = outer.content.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') as Record<string, unknown> | undefined;
    if (typeof text?.text !== 'string') throw new Error('MCP response has no JSON text content');
    if (Buffer.byteLength(text.text, 'utf8') > MAX_INPUT_BYTES) throw new Error('Context pack exceeds 1000000 bytes');
    try { candidate = JSON.parse(text.text); } catch { throw new Error('MCP text content is not valid JSON'); }
  }
  const serialized = JSON.stringify(candidate);
  if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw new Error('Context pack exceeds 1000000 bytes');
  const pack = object(candidate, 'context pack');
  if (!Array.isArray(pack.asset_refs)) throw new Error('context pack.asset_refs must be an array');
  const receipt = object(pack.pack_receipt, 'context pack.pack_receipt');
  positiveInteger(receipt.max_items, 'pack_receipt.max_items'); positiveInteger(receipt.max_chars, 'pack_receipt.max_chars');
  nonNegativeInteger(receipt.total_items, 'pack_receipt.total_items'); nonNegativeInteger(receipt.total_used_chars, 'pack_receipt.total_used_chars');
  if (receipt.partial !== undefined && typeof receipt.partial !== 'boolean') throw new Error('pack_receipt.partial must be boolean');
  return pack;
}

function identity(ref: ContextAuditReference): string { return `${ref.member}\0${ref.id}\0${ref.version ?? '*'}`; }
function matches(actual: ContextAuditReference, expected: ContextAuditReference): boolean {
  return actual.member === expected.member && actual.id === expected.id && (expected.version === undefined || actual.version === expected.version);
}

function actualReferences(value: unknown): ContextAuditReference[] {
  return (value as unknown[]).map((item, index) => parseReference(item, `context pack.asset_refs[${index}]`));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasInlineBody(pack: Record<string, unknown>, member: ContextMember): boolean {
  const rows: Array<{ member: ContextMember; item: unknown }> = [];
  if (member === 'memory' && Array.isArray(pack.items)) for (const item of pack.items) rows.push({ member: 'memory', item });
  if (Array.isArray(pack.contributions)) for (const contribution of pack.contributions) {
    const group = contribution && typeof contribution === 'object' ? contribution as Record<string, unknown> : {};
    if (group.member === member && Array.isArray(group.items)) for (const item of group.items) rows.push({ member, item });
  }
  if (member === 'codebase') {
    const codebase = pack.codebase && typeof pack.codebase === 'object' ? pack.codebase as Record<string, unknown> : {};
    if (Array.isArray(codebase.references)) for (const item of codebase.references) rows.push({ member, item });
  }
  if (Array.isArray(pack.host_refs)) for (const item of pack.host_refs) {
    const ref = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (ref.member === member) rows.push({ member, item });
  }
  return rows.some(({ item }) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return BODY_FIELDS.some(key => typeof row[key] === 'string' && (row[key] as string).length > 0);
  });
}

function add(checks: ContextAuditCheck[], id: string, pass: boolean | null, observed: number | boolean | null, expected: number | boolean | null): void {
  checks.push({ id, status: pass === null ? 'inconclusive' : pass ? 'passed' : 'failed', observed, expected });
}

function sha256Json(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

/** Deterministic receipt audit; it does not claim that a Host used or benefited from the selected material. */
export function auditContextPack(packValue: unknown, manifestValue: unknown): ContextAuditReport {
  const spec = validateManifest(manifestValue);
  const pack = unwrapPack(packValue);
  const refs = actualReferences(pack.asset_refs);
  const receipt = pack.pack_receipt as Record<string, unknown>;
  const injection = pack.injection_measurement && typeof pack.injection_measurement === 'object' ? pack.injection_measurement as Record<string, unknown> : {};
  const selectedItems = numberOrNull(receipt.total_items)!;
  const selectedChars = numberOrNull(receipt.total_used_chars)!;
  const estimatedTokens = numberOrNull(injection.estimated_tokens);
  const hostMeasuredTokens = numberOrNull(injection.host_measured_tokens);
  const duplicateRefCount = refs.length - new Set(refs.map(identity)).size;
  const requiredFound = spec.required_refs.filter(expected => refs.some(actual => matches(actual, expected))).length;
  const forbiddenFound = spec.forbidden_refs.filter(expected => refs.some(actual => matches(actual, expected))).length;
  const unexpected = spec.allowed_refs.length === 0 ? 0 : refs.filter(actual => !spec.allowed_refs.some(expected => matches(actual, expected))).length;
  const checks: ContextAuditCheck[] = [];
  if (spec.required_refs.length > 0) add(checks, 'required_refs', requiredFound === spec.required_refs.length, requiredFound, spec.required_refs.length);
  if (spec.forbidden_refs.length > 0) add(checks, 'forbidden_refs', forbiddenFound === 0, forbiddenFound, 0);
  if (spec.allowed_refs.length > 0) add(checks, 'allowed_refs', unexpected === 0, unexpected, 0);
  add(checks, 'no_duplicate_refs', duplicateRefCount === 0, duplicateRefCount, 0);
  add(checks, 'reported_item_budget', selectedItems <= Number(receipt.max_items), selectedItems, Number(receipt.max_items));
  add(checks, 'reported_char_budget', selectedChars <= Number(receipt.max_chars), selectedChars, Number(receipt.max_chars));
  if (spec.max_items !== undefined) add(checks, 'selected_item_budget', selectedItems <= spec.max_items, selectedItems, spec.max_items);
  if (spec.max_chars !== undefined) add(checks, 'selected_char_budget', selectedChars <= spec.max_chars, selectedChars, spec.max_chars);
  if (spec.max_estimated_tokens !== undefined) add(checks, 'token_budget', estimatedTokens === null ? null : estimatedTokens <= spec.max_estimated_tokens, estimatedTokens, spec.max_estimated_tokens);
  if (spec.require_host_token_measurement === true) add(checks, 'host_token_measurement', hostMeasuredTokens === null ? null : true, hostMeasuredTokens, true);
  for (const member of spec.reference_only_members) add(checks, `no_inline_${member}`, !hasInlineBody(pack, member), hasInlineBody(pack, member), false);
  const partialValue = receipt.partial ?? pack.partial ?? false;
  const partial = partialValue === true;
  add(checks, 'complete_pack', partial ? null : true, partial, false);
  const failed = checks.some(check => check.status === 'failed');
  const inconclusive = checks.some(check => check.status === 'inconclusive');
  const status = failed ? 'failed' : inconclusive ? 'inconclusive' : 'passed';
  const recall = spec.required_refs.length === 0 ? null : requiredFound / spec.required_refs.length;
  return { schema: 'craft-eval.context-audit-report.v1', case_id: spec.case_id, status, pack_sha256: sha256Json(pack), expectations_sha256: sha256Json(spec),
    metrics: { selected_ref_count: refs.length, selected_item_count: selectedItems, selected_chars: selectedChars, estimated_tokens: estimatedTokens,
      host_measured_tokens: hostMeasuredTokens, required_ref_recall: recall, forbidden_ref_count: forbiddenFound, duplicate_ref_count: duplicateRefCount },
    checks, partial,
    limitations: ['Measures a saved Context receipt against explicit labels and budgets; it does not prove the Host used or benefited from the material.',
      'Token estimates are approximate. Host token cost is verified only when a Host measurement is present.'] };
}
