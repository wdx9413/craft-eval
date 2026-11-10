import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTaskInput, validateTaskContext } from '../src/task-context.js';
import { runSuite, reportRun } from '../src/evaluation.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('task context validates bounded exact text and records submitted bytes without claiming consumption', () => {
  for (const value of [null, [], '', {}, { id: 'bad id', text: 'body' }, { id: 1, text: 'body' },
    { id: 'ok', text: '' }, { id: 'ok', text: '  ' }, { id: 'ok', text: null }, { id: 'ok', text: '\0' },
    { id: 'ok', text: '中'.repeat(22_000) }, { id: 'ok', text: 'body', extra: true }]) {
    assert.throws(() => validateTaskContext(value), /subject.context/);
  }
  const context = validateTaskContext({ id: 'claim.1', text: '  确切内容\n<Task>  ' });
  assert.equal(context.text, '  确切内容\n<Task>  ');
  assert.equal(validateTaskContext({ id: 'limit', text: 'x'.repeat(65_536) }).text.length, 65_536);
  const baseline = prepareTaskInput('task'), candidate = prepareTaskInput('task', context);
  assert.equal(baseline.prompt, 'task');
  assert.deepEqual(baseline.receipt, { task_prompt_sha256: hash('task'), submitted_prompt_sha256: hash('task'), context_id: null, context_sha256: null });
  assert.equal(candidate.receipt.context_id, 'claim.1'); assert.equal(candidate.receipt.context_sha256, hash(context.text));
  assert.equal(candidate.receipt.task_prompt_sha256, baseline.receipt.task_prompt_sha256);
  assert.equal(candidate.receipt.submitted_prompt_sha256, hash(candidate.prompt));
  assert.ok(candidate.prompt.includes(JSON.stringify(context)));
  assert.notEqual(candidate.receipt.submitted_prompt_sha256, baseline.receipt.submitted_prompt_sha256);
});

test('both host adapters receive the exact explicit intervention and reports bind it to the original task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-eval-context-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  const write = async (name: string, value: unknown) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  const suite = { schema: 'craft-eval.eval.v1', suite_id: 'context', subject_kind: 'agent', partition: 'held_out', sanitized: true, approved_by: 'test', cases: [{ id: 'task', prompt: 'Only the original task', timeout_s: 3, checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] };
  const suitePath = await write('suite.json', suite);
  const runtime = await write('runtime.json', Object.fromEntries(['environment_digest', 'budget_digest', 'host_digest', 'model_digest', 'tools_digest'].map(key => [key, 'fixed'])));
  await writeFile(join(workspace, 'host.mjs'), `import {mkdirSync, writeFileSync} from 'node:fs';
const codex = process.argv.includes('exec');
function finish(prompt) {
  mkdirSync('outputs', {recursive:true}); writeFileSync('outputs/input.json', JSON.stringify({prompt}));
  const events = codex ? [{type:'turn.completed', usage:{input_tokens:1,output_tokens:1}}] : [{type:'system',subtype:'init',model:'observed'}, {type:'result',subtype:'success',result:'done',usage:{input_tokens:1,output_tokens:1}}];
  for (const event of events) console.log(JSON.stringify(event));
}
if (codex) { let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{input+=chunk}); process.stdin.on('end',()=>finish(input)); }
else finish(process.argv.at(-1));
`);
  try {
    for (const kind of ['codex', 'claude']) {
      for (const context of [undefined, { id: 'exact-claim', text: 'Original knowledge bytes 中文' }]) {
        const subject = await write('subject.json', { kind: 'agent', id: 'context-subject', version: 'v1', host: { kind, binary: process.execPath, args_prefix: ['host.mjs'] }, ...(context ? { context } : {}) });
        const run = await runSuite(suitePath, subject, runtime, workspace, join(root, 'runs'), { keep_traces: true });
        const result = (await reportRun(run)).results[0]!;
        assert.equal(result.verdict, 'passed');
        const captured = JSON.parse(await readFile(join(run, 'captures/task-1/outputs/input.json'), 'utf8')) as { prompt: string };
        const input = prepareTaskInput(suite.cases[0]!.prompt, context);
        assert.equal(captured.prompt, input.prompt); assert.deepEqual(result.input_receipt, input.receipt);
        const plan = JSON.parse(await readFile(join(run, 'plan.json'), 'utf8'));
        assert.deepEqual(plan.subject.context, context ? { id: context.id, sha256: hash(context.text) } : null);
        assert.equal(JSON.stringify(plan.subject).includes('Original knowledge bytes'), false);
      }
    }
    const subject = await write('subject.json', { kind: 'agent', id: 's', version: 'v1', context: { id: 'c', text: 'body' } });
    await assert.rejects(runSuite(suitePath, subject, runtime, workspace, join(root, 'runs')), /requires an agent host/);
    const mixed = await write('mixed.json', { ...suite, cases: [{ id: 'argv', argv: [process.execPath, '-e', 'process.exit(0)'], checks: [{ id: 'exit', kind: 'exit_code', equals: 0 }] }] });
    const hostSubject = await write('subject.json', { kind: 'agent', id: 's', version: 'v1', host: { kind: 'claude', binary: process.execPath }, context: { id: 'c', text: 'body' } });
    await assert.rejects(runSuite(mixed, hostSubject, runtime, workspace, join(root, 'runs')), /context requires a host prompt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
