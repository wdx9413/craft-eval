import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compact,
  compactWithPromotion,
  type CompactionSegment,
} from '../src/compaction.js';
import {
  buildExperienceRecord,
  decideExperienceCapture,
  fuseRankings,
  ReversibleContext,
} from '../src/context-retrieval-capture.js';
import {
  attributeFailure,
  FAILURE_CLASSES,
  summarizeAttributions,
} from '../src/failure-attribution.js';
import {
  compactionPlan,
  constraintChannelRisk,
  defineConstraint,
  detectConstraintDecay,
  estimateTokens as governanceTokens,
  pinConstraints,
  verifyPinIntact,
} from '../src/governance-pinning.js';
import {
  CAPABILITY_AXES,
  defineEvalCase,
  defineEvalSuite,
  gradeCase,
  summarizeSuiteRun,
  type EvalCase,
} from '../src/eval-suite.js';
import {
  classifyComplexity,
  createBudgetState,
  estimatePromptTokens,
  estimateTokens,
  remainingTokens,
  routeModel,
  spendTokens,
  truncateToBudget,
} from '../src/token-budget.js';
import {
  evaluateVerificationCheck,
  runVerification,
  summarizeVerification,
  verificationCaptureSignals,
} from '../src/verification-sensor.js';
import {
  buildAbstraction,
  findRecurringFailures,
  trajectoryFailureSignature,
  abstractAcrossTrajectories,
} from '../src/trajectory-abstraction.js';
import { ARITHMETIC, COUNTING_TASKS, DETERMINISTIC_TASKS } from '../src/cases.js';
import {
  checkFor,
  CONTEXT_SUPPLY_MARKER,
  MEMORY_SUPPLY_MARKER,
  contextSupplyAidedPrompt,
  contextSupplyControlPrompt,
  evalCases,
  evaluationSuite,
  memorySupplyAidedPrompt,
  memorySupplyControlPrompt,
  PROACTIVE_ACT,
  PROACTIVE_SCENARIOS,
  proactivePrompt,
} from '../src/eval-cases.js';
import { normalizeModelPricing } from '../src/settings.js';
import { sanitizeModelEgressRequest } from '../src/model-egress-security.js';

test('compaction keeps a contiguous tail, protects constraints and reports unbound ids', () => {
  const segments: CompactionSegment[] = [
    { id: 'a', role: 'user', content: 'aaaa', weight: 1, tokens: 3 },
    { id: 'b', role: 'user', content: 'bbbb', weight: 2, tokens: 3 },
    { id: 'c', role: 'user', content: 'cccc', weight: 2, tokens: 3 },
    { id: 'rule', role: 'system', content: 'never delete', tokens: 5 },
  ];
  const result = compact({ segments, max_tokens: 8, tail_share: 0.5, protect: ['rule', 'ghost'] });
  assert.deepEqual(result.kept, ['b', 'c', 'rule']);
  assert.deepEqual(result.elided, ['a']);
  assert.deepEqual(result.protected_ids, ['rule']);
  assert.deepEqual(result.unbound, ['ghost']);
  assert.equal(result.tokens, 6);
  assert.equal(result.protected_tokens, 5);
  assert.equal(result.total_tokens, 11);
  assert.equal(result.complete, false);
  assert.match(result.summary ?? '', /Compacted 1 earlier segment/);
  assert.equal(compact({ segments: [], max_tokens: 1 }).complete, true);
  assert.equal(compact({ segments, max_tokens: 100 }).unchanged, true);
  assert.equal(compact({ segments, max_tokens: 100, summarize: (elided) => elided.length ? 'x' : 'y' }).summary, null);
  assert.throws(() => compact({ segments, max_tokens: 0 }), /max_tokens/);
  assert.throws(() => compact({ segments, max_tokens: 1, tail_share: 2 }), /tail_share/);
  assert.throws(() => compact({ max_tokens: 1, segments: [segments[0]!, segments[0]!] }), /unique/);
  assert.throws(() => compact({ segments: [{ id: 'x', content: '', tokens: -1 }], max_tokens: 1 }), /invalid token cost/);
  assert.throws(() => compact({ segments, max_tokens: 1, estimate: 1 as unknown as (value: string) => number }), /estimator/);
  assert.throws(() => compactWithPromotion({ segments, max_tokens: 10 }, 'missing'), /does not exist/);
  assert.throws(() => compactWithPromotion({ segments, max_tokens: 1 }, 'a'), /cannot be restored/);
  const promoted = compactWithPromotion({ segments, max_tokens: 7 }, 'a');
  assert.ok(promoted.kept.includes('a'));
});

test('reversible context retains the original and restores an omitted segment', () => {
  const context = new ReversibleContext((value) => value.length);
  context.append('first', 'user', 'one', 1);
  context.append('second', 'user', 'two', 2);
  context.append('third', 'user', 'three', 3);
  assert.equal(context.size, 3);
  assert.equal(context.totalTokens, 11);
  assert.deepEqual(context.original().map((item) => item.id), ['first', 'second', 'third']);
  const projected = context.project(6);
  assert.deepEqual(projected.segments.map((item) => item.id), ['third']);
  assert.deepEqual(projected.omitted, ['first', 'second']);
  assert.equal(projected.complete, false);
  const restored = context.restore('first', 8);
  assert.ok(restored.segments.some((item) => item.id === 'first'));
  assert.ok(context.restore('second', 6).segments.some((item) => item.id === 'second'));
  assert.throws(() => context.restore('missing', 8), /does not exist/);
  assert.throws(() => context.project(0), /positive integer/);
  assert.throws(() => context.append('first', 'user', 'again'), /already exists/);
  assert.throws(() => context.append('', 'user', 'x'), /id/);
  assert.throws(() => context.append('x', '', 'x'), /role/);
  assert.throws(() => context.append('y', 'user', ''), /content/);
  assert.throws(() => context.append('z', 'user', 'x', -1), /weight/);
  assert.throws(() => new ReversibleContext(null as unknown as (value: string) => number), /estimator/);
  assert.equal(context.seal().segments, 3);
});

test('rank fusion and deterministic capture reflect observed signals', () => {
  assert.deepEqual(fuseRankings([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }]], 10).map((item) => [item.id, item.sources]), [['b', 2], ['a', 1]]);
  assert.throws(() => fuseRankings([], 0), /positive number/);
  const routine = decideExperienceCapture({ outcome: 'succeeded' });
  assert.equal(routine.capture, false);
  assert.equal(routine.kind, 'routine');
  const corrected = decideExperienceCapture({ outcome: 'succeeded', corrections: 1 });
  assert.equal(corrected.capture, true);
  assert.equal(corrected.kind, 'correction');
  const explicit = decideExperienceCapture({ outcome: 'failed', user_explicit: true, retries: 1, distinct_tools: 3, novel: true });
  assert.equal(explicit.kind, 'working_pattern');
  assert.ok(explicit.reasons.includes('novel_situation'));
  assert.throws(() => decideExperienceCapture({ outcome: 'unknown' }), /unsupported/);
  assert.throws(() => decideExperienceCapture({ outcome: 'failed', retries: -1 }), /non-negative/);
  assert.throws(() => decideExperienceCapture({ outcome: 'failed', threshold: -1 }), /threshold/);
  const record = buildExperienceRecord({ outcome: 'failed', summary: 'broke', task_id: 't1', scope: 'global', experience_id: 'exp' });
  assert.equal(record.experience_id, 'exp');
  assert.equal(record.requires_review, true);
  assert.throws(() => buildExperienceRecord({ outcome: 'succeeded', summary: 'nothing' }), /threshold/);
  assert.throws(() => buildExperienceRecord({ outcome: 'failed' }), /summary/);
});

test('failure attribution names one cause in pipeline order', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ evidence_already_in_input: true }, 'echo_gap'],
    [{ source_contained_answer: false }, 'coverage_gap'],
    [{ superseded_by_newer: true }, 'revision_gap'],
    [{ wrong_scope_applied: true }, 'scope_gap'],
    [{ wrong_time_applied: true }, 'temporal_gap'],
    [{ relevant_retrieved: false }, 'retrieval_gap'],
    [{ answer_in_context: false }, 'retrieval_gap'],
    [{ fact_extracted: false }, 'grounding_gap'],
    [{ answer_wrong_with_full_context: true }, 'synthesis_gap'],
    [{}, 'unattributed'],
  ];
  for (const [input, expected] of cases) {
    const result = attributeFailure(input);
    assert.equal(result.failure_class, expected);
    assert.equal(result.attributed, expected !== 'unattributed');
    assert.equal(result.total_signals, 9);
  }
  assert.throws(() => attributeFailure({ fact_extracted: 'yes' }), /boolean/);
  const summary = summarizeAttributions({ failures: [{}, { evidence_already_in_input: true }, { evidence_already_in_input: true }] });
  assert.equal(summary.total, 3);
  assert.equal(summary.unattributed_count, 1);
  assert.equal(summary.primary, 'echo_gap');
  assert.deepEqual(summary.classes, FAILURE_CLASSES);
  assert.throws(() => summarizeAttributions({ failures: [] }), /non-empty/);
  assert.throws(() => summarizeAttributions({ failures: [null] }), /must be an object/);
});

test('governance pinning keeps constraints out of eviction and detects decay', () => {
  const constraints = [
    { id: 'b', kind: 'prohibited_effect', statement: 'never delete', effect: 'delete', scope: '*' },
    { id: 'a', kind: 'required_precondition', statement: 'ask first', effect: 'write' },
  ];
  const pin = pinConstraints(constraints);
  assert.deepEqual(pin.constraint_ids, ['a', 'b']);
  assert.match(pin.text, /ask first/);
  assert.equal(pin.tokens, governanceTokens(pin.text));
  assert.throws(() => pinConstraints([]), /non-empty/);
  assert.throws(() => pinConstraints([null as unknown as Record<string, unknown>]), /must be an object/);
  assert.throws(() => pinConstraints([constraints[0]!, constraints[0]!]), /unique/);
  assert.throws(() => defineConstraint({ kind: 'other', id: 'x', statement: 's', effect: 'e' }), /unsupported/);
  const plan = compactionPlan({
    max_tokens: 6,
    constraints,
    segments: [
      { id: 'a', content: 'ask first' },
      { id: 'b', content: 'never delete' },
      { id: 'c', content: 'task state', tokens: 5 },
      { id: 'd', content: 'more state', tokens: 5 },
    ],
  });
  assert.deepEqual(plan.pinned, ['a', 'b']);
  assert.equal(plan.constraints_preserved, true);
  assert.deepEqual(plan.kept, ['d']);
  assert.deepEqual(plan.omitted, ['c']);
  const missing = compactionPlan({ max_tokens: 5, constraints, segments: [{ id: 'c', content: 'x', tokens: 1 }] });
  assert.equal(missing.constraints_preserved, false);
  assert.deepEqual(missing.unbound_constraints, ['a', 'b']);
  assert.throws(() => compactionPlan({ max_tokens: 1, constraints, segments: [null] }), /must be an object/);
  assert.throws(() => compactionPlan({ max_tokens: 0, constraints, segments: [] }), /max_tokens/);
  const intact = verifyPinIntact({ constraints, rendered: pin.text });
  assert.equal(intact.verdict, 'preserved');
  assert.equal(verifyPinIntact({ constraints, rendered: 'ask first' }).verdict, 'dropped');
  assert.equal(verifyPinIntact({ constraints, rendered: 'a b ask first never delete' }).verdict, 'preserved');
  assert.equal(verifyPinIntact({ constraints, rendered: 'a b ask first' }).verdict, 'reworded');
  assert.equal(verifyPinIntact({ constraints, rendered: 'a b ask first never removed' }).verdict, 'reworded');
  assert.throws(() => verifyPinIntact({ constraints: [], rendered: '' }), /non-empty/);
  assert.throws(() => verifyPinIntact({ constraints, rendered: 1 }), /rendered/);
  assert.equal(detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: true, constraint_dropped: true }).attributable_to_pinning, true);
  assert.equal(detectConstraintDecay({ violated_before_compaction: true, violated_after_compaction: true, constraint_dropped: true }).decay_detected, false);
  assert.equal(detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: true, constraint_dropped: false }).attributable_to_pinning, false);
  assert.equal(detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: false, constraint_dropped: false }).decay_detected, false);
  assert.throws(() => detectConstraintDecay({ violated_before_compaction: 1, violated_after_compaction: true, constraint_dropped: true }), /booleans/);
  assert.throws(() => detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: true }), /constraint_dropped/);
  assert.equal(constraintChannelRisk({ channels: ['memory', 'tool_output'] }).exposure, 78);
  assert.equal(constraintChannelRisk({ channels: ['system'] }).recommendation, 'no compacted channel carries this constraint');
  assert.throws(() => constraintChannelRisk({ channels: [] }), /non-empty/);
  assert.throws(() => constraintChannelRisk({ channels: [1] }), /must not be empty/);
  assert.throws(() => constraintChannelRisk({ channels: ['email'] }), /unsupported/);
});

test('evaluation suites reject unobservable claims and grade inconclusive separately', () => {
  const base = {
    id: 'case', axis: 'memory', evidence: 'kernel', partition: 'held_out',
    sanitized: true, approved_by: 'reviewer', description: 'd',
  };
  const evalCase = defineEvalCase(base);
  assert.equal(evalCase.ledger, 'capability');
  assert.throws(() => defineEvalCase({ ...base, axis: 'unknown' }), /axis/);
  assert.throws(() => defineEvalCase({ ...base, evidence: 'guess' }), /evidence/);
  assert.throws(() => defineEvalCase({ ...base, axis: 'governance', evidence: 'kernel' }), /model output/);
  assert.throws(() => defineEvalCase({ ...base, partition: 'development' }), /held out/);
  assert.throws(() => defineEvalCase({ ...base, sanitized: false }), /sanitized/);
  assert.throws(() => defineEvalCase({ ...base, description: '' }), /description/);
  const suite = defineEvalSuite({ suite_id: 's', version: '1', cases: [base, { ...base, id: 'case2' }] });
  assert.equal(suite.case_count, 2);
  assert.deepEqual((suite.cases as EvalCase[]).map((item) => item.id), ['case', 'case2']);
  assert.equal((suite.by_axis as Record<string, number>).memory, 2);
  assert.throws(() => defineEvalSuite({ suite_id: 's', version: '1', cases: [] }), /non-empty/);
  assert.throws(() => defineEvalSuite({ suite_id: 's', version: '1', cases: [null] }), /must be an object/);
  assert.throws(() => defineEvalSuite({ suite_id: 's', version: '1', cases: [base, base] }), /unique/);
  assert.equal(gradeCase({ case_id: 'c', observed: false }).verdict, 'inconclusive');
  assert.equal(gradeCase({ case_id: 'c', observed: false, unobserved_reason: 'offline' }).reason, 'offline');
  assert.equal(gradeCase({ case_id: 'c', observed: true, passed: true }).counted_as_pass, true);
  assert.equal(gradeCase({ case_id: 'c', observed: true, passed: false }).reason, 'no failure reason recorded');
  assert.equal(gradeCase({ case_id: 'c', observed: true, passed: false, failure_reason: 'bad' }).reason, 'bad');
  assert.throws(() => gradeCase({ case_id: 'c', observed: 'yes' }), /observed/);
  assert.throws(() => gradeCase({ case_id: 'c', observed: true }), /passed/);
  const cases: EvalCase[] = CAPABILITY_AXES.map((axis) => ({
    id: `${axis}.one`, axis, ledger: axis === 'governance' ? 'safety' : axis === 'context_supply' ? 'value' : 'capability',
    evidence: 'kernel', description: axis, partition: 'held_out', sanitized: true, approved_by: 'r',
  }));
  const summary = summarizeSuiteRun({
    suite: { suite_id: 's', version: '1', cases },
    results: cases.map((item) => ({ case_id: item.id, verdict: 'passed' })),
  });
  assert.equal(summary.total_cases, cases.length);
  assert.equal(summary.quotable, false);
  assert.match(String(summary.quotable_reason), /below the declared minimum/);
  assert.equal(summary.comparable_to_published_benchmarks, false);
  assert.throws(() => summarizeSuiteRun({ suite: null, results: [] }), /suite/);
  assert.throws(() => summarizeSuiteRun({ suite: { cases }, results: [] }), /results/);
  assert.throws(() => summarizeSuiteRun({ suite: { cases }, results: [null] }), /results\[0\]/);
  assert.throws(() => summarizeSuiteRun({ suite: { cases: [] }, results: [{}] }), /suite.cases/);
  const unrun = summarizeSuiteRun({ suite: { suite_id: 's', cases }, results: [{ case_id: 'memory.one', verdict: 'passed' }] });
  assert.equal((unrun.unrun as string[]).length, cases.length - 1);
});

test('token budgeting is deterministic and reports overspend instead of throwing', () => {
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimatePromptTokens(['abcd', 'efgh']), 2);
  assert.throws(() => estimateTokens(1 as unknown as string), /string/);
  assert.throws(() => estimatePromptTokens('x' as unknown as string[]), /array/);
  const state = createBudgetState(10, 2);
  assert.equal(remainingTokens(state), 8);
  assert.equal(spendTokens(state, 9).exceeded, true);
  assert.equal(spendTokens(state, 1).remaining, 7);
  assert.throws(() => createBudgetState(0), /limit/);
  assert.throws(() => createBudgetState(2, 2), /reserve/);
  assert.throws(() => spendTokens(state, -1), /non-negative/);
  const full = truncateToBudget('abcd', 1);
  assert.equal(full.truncated, false);
  const short = truncateToBudget('x'.repeat(40), 2);
  assert.equal(short.truncated, true);
  assert.match(short.text, /…/);
  assert.equal(truncateToBudget('中文中文', 1).text, '…');
  assert.throws(() => truncateToBudget('x', 0), /positive integer/);
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 1, context_chars: 1, requires_external_write: false, requires_multi_step_reasoning: false }), 'small');
  assert.equal(classifyComplexity({ steps: 4, distinct_paths: 1, context_chars: 1, requires_external_write: false, requires_multi_step_reasoning: false }), 'standard');
  assert.equal(classifyComplexity({ steps: 1, distinct_paths: 1, context_chars: 1, requires_external_write: true, requires_multi_step_reasoning: false }), 'frontier');
  assert.throws(() => classifyComplexity({ steps: -1, distinct_paths: 1, context_chars: 1, requires_external_write: false, requires_multi_step_reasoning: false }), /steps/);
  assert.deepEqual(routeModel({ host: 'h', models: { standard: 'm' }, tier: 'standard' }), { tier: 'standard', model: 'm', downgraded: false, reason: 'tier_available' });
  assert.deepEqual(routeModel({ host: 'h', models: { small: 'm' }, tier: 'frontier' }), { tier: 'small', model: 'm', downgraded: true, reason: 'downgraded_to_available_tier' });
  assert.deepEqual(routeModel({ host: 'h', models: {}, tier: 'standard' }), { tier: 'standard', model: null, downgraded: false, reason: 'host_default:h' });
  assert.throws(() => routeModel({ host: '', models: {}, tier: 'standard' }), /host/);
  assert.throws(() => routeModel({ host: 'h', models: {}, tier: 'huge' as never }), /tier/);
});

test('verification checks distinguish blocked, failed and passed from observed bytes', () => {
  assert.equal(evaluateVerificationCheck({ kind: 'exit_code', name: 'e', observed_exit_code: 0 }).verdict, 'passed');
  assert.equal(evaluateVerificationCheck({ kind: 'exit_code', name: 'e', observed_exit_code: 1 }).verdict, 'failed');
  assert.equal(evaluateVerificationCheck({ kind: 'exit_code', name: 'e' }).verdict, 'blocked');
  assert.throws(() => evaluateVerificationCheck({ kind: 'exit_code', name: 'e', expected_exit_code: 1.5 }), /integer/);
  assert.throws(() => evaluateVerificationCheck({ kind: 'exit_code', name: 'e', observed_exit_code: 1.5 }), /integer/);
  assert.equal(evaluateVerificationCheck({ kind: 'output_contains', name: 'o', expected_substring: 'a', observed_output: 'abc' }).verdict, 'passed');
  assert.equal(evaluateVerificationCheck({ kind: 'output_contains', name: 'o', expected_substring: 'z', observed_output: '' }).verdict, 'failed');
  assert.equal(evaluateVerificationCheck({ kind: 'output_contains', name: 'o', expected_substring: 'a' }).verdict, 'blocked');
  assert.equal(evaluateVerificationCheck({ kind: 'output_matches', name: 'o', expected_pattern: '^a', observed_output: 'abc' }).verdict, 'passed');
  assert.equal(evaluateVerificationCheck({ kind: 'output_matches', name: 'o', expected_pattern: '(', observed_output: 'abc' }).verdict, 'blocked');
  assert.equal(evaluateVerificationCheck({ kind: 'file_digest', name: 'f', expected_digest: 'd', observed_digest: 'd' }).verdict, 'passed');
  assert.equal(evaluateVerificationCheck({ kind: 'file_digest', name: 'f', expected_digest: 'd', observed_digest: 'x' }).verdict, 'failed');
  assert.equal(evaluateVerificationCheck({ kind: 'file_digest', name: 'f', expected_digest: 'd' }).verdict, 'blocked');
  assert.equal(evaluateVerificationCheck({ kind: 'file_absent', name: 'f', observed_present: false }).verdict, 'passed');
  assert.equal(evaluateVerificationCheck({ kind: 'file_absent', name: 'f', observed_present: true }).verdict, 'failed');
  assert.equal(evaluateVerificationCheck({ kind: 'file_absent', name: 'f' }).verdict, 'blocked');
  assert.throws(() => evaluateVerificationCheck({ kind: 'file_absent', name: 'f', observed_present: 'no' }), /boolean/);
  assert.throws(() => evaluateVerificationCheck({ kind: 'nope', name: 'f' }), /unsupported/);
  const checks = [
    evaluateVerificationCheck({ kind: 'exit_code', name: 'a', observed_exit_code: 0 }),
    evaluateVerificationCheck({ kind: 'output_contains', name: 'b', expected_substring: 'z', observed_output: '' }),
  ];
  const summary = summarizeVerification(checks);
  assert.equal(summary.verdict, 'failed');
  assert.deepEqual(summary.failed_checks, ['b']);
  assert.throws(() => summarizeVerification([]), /at least one/);
  assert.throws(() => summarizeVerification([{ ...checks[0]!, verdict: 'odd' as never }]), /unsupported/);
  assert.throws(() => summarizeVerification([checks[0]!, checks[0]!]), /unique/);
  const blocked = summarizeVerification([evaluateVerificationCheck({ kind: 'exit_code', name: 'a' })]);
  assert.equal(blocked.verdict, 'blocked');
  assert.equal(blocked.verifiable, false);
  const signals = verificationCaptureSignals({ checks: [{ kind: 'exit_code', name: 'a', observed_exit_code: 1 }], retries: 2 });
  assert.equal(signals.outcome, 'failed');
  assert.equal(signals.corrections, 1);
  assert.equal(verificationCaptureSignals({ checks: [{ kind: 'exit_code', name: 'a' }] }).outcome, 'abandoned');
  assert.throws(() => verificationCaptureSignals({ checks: [], retries: 0 }), /non-empty/);
  assert.throws(() => verificationCaptureSignals({ checks: [{ kind: 'exit_code', name: 'a' }], retries: -1 }), /retries/);
  assert.equal(runVerification({ checks: [{ kind: 'exit_code', name: 'a', observed_exit_code: 0 }] }).verdict, 'passed');
  assert.throws(() => runVerification({ checks: [null] }), /must be an object/);
});

test('trajectory abstraction only generalises a repeated failure across distinct tasks', () => {
  const failed = (task: string, check = 'exact') => ({ trace_id: `t-${task}`, task_id: task, failed_checks: [`${task}:${check}`], outcome: 'failed' });
  assert.equal(trajectoryFailureSignature({ failed_checks: ['a:exact'] }), 'exact');
  assert.equal(trajectoryFailureSignature({ failed_checks: [] }), '');
  assert.equal(trajectoryFailureSignature({ failed_checks: 'x' as unknown as string[] }), '');
  const recurring = findRecurringFailures({ trajectories: [failed('a'), failed('b'), failed('c', 'other'), { trace_id: 'ok', task_id: 'd', failed_checks: [], outcome: 'succeeded' }] });
  assert.equal((recurring.candidates as unknown[]).length, 2);
  assert.equal(recurring.publishable_count, 1);
  const candidate = buildAbstraction({ trajectories: [failed('a'), failed('b')], signature: 'exact', scope: 'project' });
  assert.equal(candidate.requires_review, true);
  assert.equal(candidate.execution_authority, false);
  const report = abstractAcrossTrajectories({ trajectories: [failed('a'), failed('b')], scope: 'project' });
  assert.equal(report.abstraction_count, 1);
  assert.equal(report.sufficient_evidence, true);
  const thin = abstractAcrossTrajectories({ trajectories: [failed('a')], scope: 'project' });
  assert.equal(thin.abstraction_count, 0);
  assert.equal(abstractAcrossTrajectories({ trajectories: [] }).abstraction_count, 0);
  assert.throws(() => abstractAcrossTrajectories({ trajectories: [null] }), /must be an object/);
  assert.throws(() => abstractAcrossTrajectories({ trajectories: [failed('a')], scope: '' }), /scope/);
});

test('declared evaluation cases and prompts stay internally consistent', () => {
  assert.equal(ARITHMETIC.expected, '391');
  assert.ok(DETERMINISTIC_TASKS.length >= 1);
  assert.ok(COUNTING_TASKS.length >= 1);
  const all = evalCases();
  assert.equal(new Set(all.map((item) => item.case.id)).size, all.length);
  assert.ok(all.some((item) => item.case.axis === 'general_evolution'));
  const suite = evaluationSuite();
  assert.equal(suite.case_count, all.length);
  assert.equal(checkFor(all[0]!.case.id), all[0]!.check);
  assert.equal(checkFor('missing'), null);
  assert.match(contextSupplyControlPrompt(), /unknown/);
  assert.match(contextSupplyAidedPrompt(), new RegExp(CONTEXT_SUPPLY_MARKER));
  assert.match(memorySupplyControlPrompt(), /unknown/);
  assert.match(memorySupplyAidedPrompt(), new RegExp(MEMORY_SUPPLY_MARKER));
  assert.match(proactivePrompt(PROACTIVE_SCENARIOS[0]!), new RegExp(PROACTIVE_SCENARIOS[0]!.situation.slice(0, 20)));
  assert.ok([PROACTIVE_ACT, 'skip'].includes(PROACTIVE_SCENARIOS[0]!.expected));
});

test('settings pricing and egress redaction reject unsafe input', () => {
  assert.equal(normalizeModelPricing(undefined), undefined);
  assert.deepEqual(normalizeModelPricing({ version: 'v', input_usd_per_million: 1, output_usd_per_million: 2 }), { version: 'v', input_usd_per_million: 1, output_usd_per_million: 2 });
  assert.throws(() => normalizeModelPricing([]), /object/);
  assert.throws(() => normalizeModelPricing({ version: '' }), /version/);
  assert.throws(() => normalizeModelPricing({ version: 'v', input_usd_per_million: -1, output_usd_per_million: 2 }), /non-negative/);
  const spec = { base_url: 'http://127.0.0.1:8000/v1', chat_path: '/chat/completions' };
  const sanitized = sanitizeModelEgressRequest(spec, {
    url: `${spec.base_url}${spec.chat_path}`,
    body: {
      api_key: 'sk-live-secret',
      messages: [{ role: 'user', content: 'token=abc123 mail a@b.com' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { password: { type: 'string', example: 'hunter2' } } } } }],
    },
  });
  assert.equal((sanitized.body.api_key as string), '[REDACTED]');
  assert.ok(!JSON.stringify(sanitized.body).includes('sk-live-secret'));
  assert.ok(!JSON.stringify(sanitized.body).includes('hunter2'));
  const deep = sanitizeModelEgressRequest(spec, {
    url: `${spec.base_url}${spec.chat_path}`,
    body: {
      messages: [{ role: 'user', content: 'token=abc' }],
      tools: [{
        type: 'function',
        function: {
          name: 'f',
          parameters: {
            type: 'object',
            properties: {
              token: { type: 'string', default: 'plain-default', enum: ['a', 'b'] },
              token_note: { type: 'string', example: ['nested-example'] },
            },
          },
        },
      }],
    },
  });
  assert.ok(!JSON.stringify(deep.body).includes('plain-default'));
  assert.ok(!JSON.stringify(deep.body).includes('nested-example'));
  let deepBody: Record<string, unknown> = { value: 'deep' };
  for (let index = 0; index < 70; index += 1) deepBody = { nested: deepBody };
  assert.throws(() => sanitizeModelEgressRequest(spec, {
    url: `${spec.base_url}${spec.chat_path}`,
    body: deepBody,
  }), /redaction limit/);
  assert.throws(() => sanitizeModelEgressRequest(spec, { url: 'http://evil/v1/chat/completions', body: {} }), /destination/);
  assert.throws(() => sanitizeModelEgressRequest(spec, { url: `${spec.base_url}${spec.chat_path}`, body: [] as never }), /body/);
});
