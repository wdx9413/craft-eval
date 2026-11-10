import assert from 'node:assert/strict';
import test from 'node:test';
import { auditContextPack } from '../src/context-audit.js';

const ref = (member: string, id: string, version?: number) => ({ member, id, ...(version === undefined ? {} : { version }) });

function pack(overrides: Record<string, unknown> = {}) {
  return {
    asset_refs: [ref('knowledge', 'claim-a', 1), ref('codebase', 'symbol-a', 2)],
    items: [],
    contributions: [{ member: 'knowledge', items: [{ claim_id: 'claim-a', claim_version: 1, content_excerpt: '必要约束' }] }],
    codebase: { references: [{ node_id: 'symbol-a', version: 2, path: 'src/a.ts', span: { start_line: 1 } }] },
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 2, total_used_chars: 50, partial: false },
    injection_measurement: { estimated_tokens: 12, exact: false, host_measured_tokens: null },
    ...overrides,
  };
}

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schema: 'craft-eval.context-audit.v1', case_id: 'login-flow',
  required_refs: [ref('knowledge', 'claim-a', 1)], forbidden_refs: [ref('memory', 'private-note')],
  allowed_refs: [ref('knowledge', 'claim-a', 1), ref('codebase', 'symbol-a', 2)],
  max_items: 2, max_chars: 60, max_estimated_tokens: 20, reference_only_members: ['codebase'],
  ...overrides,
});

test('context audit accepts an exact bounded pack and reports only measurable selection evidence', () => {
  const result = auditContextPack(pack(), manifest());
  assert.equal(result.status, 'passed');
  assert.equal(result.case_id, 'login-flow');
  assert.match(result.pack_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.expectations_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.metrics, {
    selected_ref_count: 2, selected_item_count: 2, selected_chars: 50, estimated_tokens: 12,
    host_measured_tokens: null, required_ref_recall: 1, forbidden_ref_count: 0, duplicate_ref_count: 0, response_omitted_items: 0,
  });
  assert.equal(result.checks.every(check => check.status === 'passed'), true);
  assert.match(result.limitations.join(' '), /does not prove.*used|使用/u);
});

test('context audit catches missing and forbidden assets, duplicates, unexpected refs, over-budget packs and inline code', () => {
  const broken = pack({
    asset_refs: [ref('memory', 'private-note'), ref('knowledge', 'claim-a', 1), ref('knowledge', 'claim-a', 1), ref('knowledge', 'extra')],
    pack_receipt: { max_items: 1, max_chars: 20, total_items: 3, total_used_chars: 80, partial: false },
    injection_measurement: { estimated_tokens: 30, exact: false, host_measured_tokens: null },
    codebase: { references: [{ node_id: 'symbol-a', source_text: 'do not inline source' }] },
  });
  const result = auditContextPack(broken, manifest({ required_refs: [ref('experience', 'missing')], allowed_refs: [ref('experience', 'missing'), ref('knowledge', 'claim-a', 1), ref('codebase', 'symbol-a', 2)], max_items: 2, max_chars: 60, max_estimated_tokens: 20 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.metrics.required_ref_recall, 0);
  assert.equal(result.metrics.forbidden_ref_count, 1);
  assert.equal(result.metrics.duplicate_ref_count, 1);
  assert.deepEqual(result.checks.filter(check => check.status === 'failed').map(check => check.id).sort(), [
    'allowed_refs', 'forbidden_refs', 'no_duplicate_refs', 'no_inline_codebase', 'required_refs',
    'reported_char_budget', 'reported_item_budget', 'selected_char_budget', 'selected_item_budget', 'token_budget',
  ].sort());
});

test('partial packs and absent Host token measurements remain inconclusive rather than passing silently', () => {
  const result = auditContextPack(pack({
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 2, total_used_chars: 50, partial: true },
    injection_measurement: { estimated_tokens: null, exact: false, host_measured_tokens: null },
  }), manifest({ require_host_token_measurement: true }));
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.checks.some(check => check.id === 'complete_pack' && check.status === 'inconclusive'), true);
  assert.equal(result.checks.some(check => check.id === 'host_token_measurement' && check.status === 'inconclusive'), true);
  assert.equal(result.metrics.estimated_tokens, null);
});

test('response-level budget omissions are inconclusive even when the selected pack was complete', () => {
  const result = auditContextPack(pack({
    response_partial: true,
    response_omitted_items: 2,
    response_omission_reason: 'response_token_budget',
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 2, total_used_chars: 50, partial: false },
    partial: false,
  }), manifest());
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.partial, true);
  assert.equal((result.metrics as unknown as Record<string, unknown>).response_omitted_items, 2);
  assert.equal(result.checks.some(check => check.id === 'complete_pack' && check.status === 'passed'), true);
  assert.equal(result.checks.some(check => check.id === 'complete_response' && check.status === 'inconclusive' && check.observed === 2), true);
});

test('partial diagnostics retain bounded machine-readable reasons and omission counts', () => {
  const result = auditContextPack(pack({
    partial: true,
    partial_reasons: ['codebase_budget_exhausted', 'codebase_query_truncated'],
    codebase: { status: 'ready', omitted_files: 2, budget_omitted_count: 3, query_omitted_count: 41 },
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 2, total_used_chars: 50, partial: true,
      partial_reasons: ['codebase_budget_exhausted', 'codebase_query_truncated'] },
  }), manifest());
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.partial_details, {
    reasons: ['codebase_budget_exhausted', 'codebase_query_truncated'],
    codebase: { omitted_files: 2, budget_omitted_count: 3, query_omitted_count: 41 },
  });
  assert.deepEqual(result.checks.find(check => check.id === 'partial_diagnostics')?.status, 'passed');
});

test('partial audits without causes stay inconclusive and causes on a complete pack fail consistency', () => {
  const missing = auditContextPack(pack({ partial: true, pack_receipt: { max_items: 3, max_chars: 100, total_items: 2, total_used_chars: 50, partial: true } }), manifest());
  assert.equal(missing.checks.find(check => check.id === 'partial_diagnostics')?.status, 'inconclusive');
  assert.equal(missing.status, 'inconclusive');
  const inconsistent = auditContextPack(pack({ partial: false, partial_reasons: ['codebase_query_truncated'] }), manifest());
  assert.equal(inconsistent.checks.find(check => check.id === 'partial_diagnostics')?.status, 'failed');
  assert.equal(inconsistent.status, 'failed');
  const responseCauseMissing = auditContextPack(pack({ response_partial: true, response_omitted_items: 1,
    partial_reasons: ['codebase_query_truncated'], partial: true }), manifest());
  assert.equal(responseCauseMissing.checks.find(check => check.id === 'partial_diagnostics')?.status, 'inconclusive');
});

test('positive Codebase omission counts cannot be reported as a complete pack', () => {
  const result = auditContextPack(pack({
    codebase: { references: [], omitted_files: 2 },
    partial: false,
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 0, total_used_chars: 0, partial: false },
  }), manifest());
  assert.equal(result.partial, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find(check => check.id === 'omission_consistency')?.status, 'failed');
  const unexplained = auditContextPack(pack({
    partial: true,
    codebase: { references: [], omitted_files: 2 },
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 0, total_used_chars: 0, partial: true },
  }), manifest());
  assert.equal(unexplained.checks.find(check => check.id === 'partial_diagnostics')?.status, 'inconclusive');
});

test('context audit checks reference-only members across every response group without inspecting prose values', () => {
  const response = pack({
    asset_refs: [ref('memory', 'm1'), ref('knowledge', 'k1'), ref('codebase', 'c1'), ref('history', 'h1')],
    items: [{ memory_id: 'm1', content: '' }],
    contributions: [{ member: 'knowledge', items: [{ claim_id: 'k1', content_excerpt: '' }] }, { member: 'experience', items: [{ text: 'ignored' }] }, null],
    codebase: { references: [{ node_id: 'c1' }] },
    host_refs: [null, { member: 'history', text: '' }, { member: 'state', text: 'not selected' }],
  });
  const result = auditContextPack(response, manifest({ required_refs: [ref('memory', 'm1'), ref('knowledge', 'k1'), ref('codebase', 'c1'), ref('history', 'h1')],
    forbidden_refs: [], allowed_refs: [], max_items: undefined, max_chars: undefined, max_estimated_tokens: undefined,
    reference_only_members: ['memory', 'knowledge', 'codebase', 'history'] }));
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.checks.filter(check => check.id.startsWith('no_inline_')).map(check => check.status), ['passed', 'passed', 'passed', 'passed']);
});

test('context audit validates contradictory labels, receipt counters, Host token metrics and inherited partial state', () => {
  const result = auditContextPack(pack({
    pack_receipt: { max_items: 3, max_chars: 100, total_items: 2, total_used_chars: 50 },
    partial: false,
    injection_measurement: { estimated_tokens: 'unknown', host_measured_tokens: 9 },
    codebase: { references: [] },
  }), manifest({
    required_refs: [ref('knowledge', 'claim-a')], forbidden_refs: [], allowed_refs: [],
    max_items: 3, max_chars: 100, max_estimated_tokens: undefined, require_host_token_measurement: true,
    reference_only_members: ['codebase'],
  }));
  assert.equal(result.status, 'passed');
  assert.equal(result.metrics.estimated_tokens, null);
  assert.equal(result.metrics.host_measured_tokens, 9);
  assert.equal(result.partial, false);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [ref('knowledge', 'claim-a')], forbidden_refs: [ref('knowledge', 'claim-a')] })), /both required and forbidden/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [ref('knowledge', 'claim-a')], allowed_refs: [ref('codebase', 'symbol-a')] })), /included in allowed_refs/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [ref('knowledge', 'claim-a'), ref('knowledge', 'claim-a', 1)] })), /duplicate or conflicting/u);
  assert.throws(() => auditContextPack(pack({ pack_receipt: { max_items: 0, max_chars: 1, total_items: 0, total_used_chars: 0 } }), manifest()), /positive integer/u);
  assert.throws(() => auditContextPack(pack({ pack_receipt: { max_items: 1, max_chars: 1, total_items: -1, total_used_chars: 0 } }), manifest()), /non-negative integer/u);
  assert.throws(() => auditContextPack(pack({ pack_receipt: { max_items: 1, max_chars: 1, total_items: 0, total_used_chars: 0, partial: 'yes' } }), manifest()), /partial must be boolean/u);
  assert.throws(() => auditContextPack(pack({ partial: 'true' }), manifest()), /context pack\.partial must be boolean/u);
  assert.throws(() => auditContextPack(pack({ partial: null }), manifest()), /context pack\.partial must be boolean/u);
  assert.throws(() => auditContextPack(pack({ response_partial: 'yes' }), manifest()), /response_partial must be boolean/u);
  assert.throws(() => auditContextPack(pack({ response_partial: true }), manifest()), /requires response_omitted_items/u);
  assert.throws(() => auditContextPack(pack({ response_omitted_items: -1 }), manifest()), /non-negative integer/u);
  assert.throws(() => auditContextPack(pack({ response_omitted_items: 1 }), manifest()), /requires response_partial=true/u);
  assert.throws(() => auditContextPack(pack({ partial_reasons: Array(33).fill('bounded_reason') }), manifest()), /at most 32 reason codes/u);
  assert.throws(() => auditContextPack(pack({ partial_reasons: ['reason with content'] }), manifest()), /at most 32 reason codes/u);
  assert.throws(() => auditContextPack(pack({ response_omission_reason: 'bad reason' }), manifest()), /must be a reason code/u);
  assert.throws(() => auditContextPack(pack({ codebase: { omitted_files: -1 } }), manifest()), /non-negative integer/u);
});

test('context audit handles optional assertions and rejects oversized or mistyped manifests and packs', () => {
  const optional = auditContextPack(pack({
    asset_refs: [ref('memory', 'm1')],
    contributions: [],
    codebase: undefined,
    pack_receipt: { max_items: 1, max_chars: 1, total_items: 0, total_used_chars: 0 },
    partial: false,
    injection_measurement: null,
  }), { schema: 'craft-eval.context-audit.v1', case_id: 'optional', max_items: 1, require_host_token_measurement: false });
  assert.equal(optional.status, 'passed');
  assert.equal(optional.metrics.required_ref_recall, null);
  assert.equal(optional.metrics.estimated_tokens, null);
  const noReceiptPartialFlag = auditContextPack({ asset_refs: [], pack_receipt: { max_items: 1, max_chars: 1, total_items: 0, total_used_chars: 0 } },
    { schema: 'craft-eval.context-audit.v1', case_id: 'no-partial-flag', max_items: 1 });
  assert.equal(noReceiptPartialFlag.status, 'passed');
  const noCodebase = auditContextPack(pack({ codebase: undefined }), manifest({ reference_only_members: ['codebase'], forbidden_refs: [], allowed_refs: [] }));
  assert.equal(noCodebase.status, 'passed');
  const malformedCodebaseRow = auditContextPack(pack({ codebase: { references: [null] } }), manifest({ forbidden_refs: [], allowed_refs: [], reference_only_members: ['codebase'] }));
  assert.equal(malformedCodebaseRow.status, 'passed');
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: 'claim' })), /must be an array/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: Array(10_001).fill(ref('memory', 'm')) })), /10000 references/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [{ member: 'knowledge', id: 'claim-a', version: '1' }] })), /integer/u);
  assert.throws(() => auditContextPack(pack(), manifest({ max_items: -1 })), /non-negative integer/u);
  assert.throws(() => auditContextPack(pack(), manifest({ reference_only_members: ['memory', 1] })), /reference_only_members/u);
  assert.throws(() => auditContextPack(pack(), manifest({ require_host_token_measurement: false, max_items: undefined, max_chars: undefined, max_estimated_tokens: undefined, reference_only_members: [], required_refs: [], forbidden_refs: [], allowed_refs: [] })), /at least one/u);
  assert.throws(() => auditContextPack({ asset_refs: [] }, manifest()), /pack_receipt must be an object/u);
  assert.throws(() => auditContextPack({ asset_refs: 'wrong' }, manifest()), /asset_refs must be an array/u);
  assert.throws(() => auditContextPack({ structuredContent: { asset_refs: [], pack_receipt: { max_items: 1, max_chars: 1, total_items: 0, total_used_chars: 0 }, huge: 'x'.repeat(1_000_001) } }, manifest()), /exceeds/u);
});

test('context audit accepts MCP wrappers and rejects malformed packs or manifests', () => {
  const wrapped = { structuredContent: pack() };
  assert.equal(auditContextPack(wrapped, manifest()).status, 'passed');
  assert.equal(auditContextPack({ isError: false, structuredContent: pack() }, manifest()).status, 'passed');
  assert.equal(auditContextPack({ content: [{ type: 'text', text: JSON.stringify(pack()) }] }, manifest()).status, 'passed');
  assert.throws(() => auditContextPack({ isError: true, structuredContent: pack() }, manifest()), /MCP response indicates an error/u);
  assert.throws(() => auditContextPack({ isError: true, content: [{ type: 'text', text: JSON.stringify(pack()) }] }, manifest()), /MCP response indicates an error/u);
  assert.throws(() => auditContextPack({ content: [{ type: 'text', text: 'not json' }] }, manifest()), /JSON/u);
  assert.throws(() => auditContextPack({ content: [] }, manifest()), /no JSON text/u);
  assert.throws(() => auditContextPack({ content: [{ type: 'text', text: 'x'.repeat(1_000_001) }] }, manifest()), /exceeds/u);
  assert.throws(() => auditContextPack({}, manifest()), /asset_refs/u);
  assert.throws(() => auditContextPack(null, manifest()), /context pack must be an object/u);
  assert.throws(() => auditContextPack(pack(), null), /manifest must be an object/u);
  assert.throws(() => auditContextPack(pack(), { ...manifest(), schema: 'wrong' }), /schema/u);
  assert.throws(() => auditContextPack(pack(), manifest({ case_id: 'bad id' })), /case_id/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [ref('unknown', 'x')] })), /member/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [ref('knowledge', 'claim-a', 0)] })), /positive integer/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [ref('knowledge', '')] })), /id is invalid/u);
  assert.throws(() => auditContextPack(pack(), manifest({ max_chars: 1_000_001 })), /exceeds/u);
  assert.throws(() => auditContextPack(pack(), manifest({ max_items: 0 })), /positive integer/u);
  assert.throws(() => auditContextPack(pack(), manifest({ reference_only_members: ['unknown'] })), /reference_only_members/u);
  assert.throws(() => auditContextPack(pack(), manifest({ reference_only_members: 'codebase' })), /reference_only_members/u);
  assert.throws(() => auditContextPack(pack(), manifest({ require_host_token_measurement: 'yes' })), /must be boolean/u);
  assert.throws(() => auditContextPack(pack(), manifest({ extra: true })), /unsupported field/u);
  assert.throws(() => auditContextPack(pack(), manifest({ required_refs: [], forbidden_refs: [], allowed_refs: [], max_items: undefined, max_chars: undefined, max_estimated_tokens: undefined, reference_only_members: [] })), /at least one/u);
});
