import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal stand-in for an Experience-derived Workflow/Procedure draft executed
// by the governed host. It models the three properties an evolution proposal
// must hold before promotion: idempotency, route-locking, and held-out safety.
const outputDir = process.env.CRAFT_EVAL_OUTPUT_DIR;
const tracePath = process.env.CRAFT_EVAL_TRACE_PATH;
const taskRunId = process.env.CRAFT_EVAL_TASK_RUN_ID;
const declaredEntry = 'claim-revision';

mkdirSync(outputDir, { recursive: true });

// Deterministic plan digest: a real procedure would hash its verified graph,
// not the training set. Fixed here so repeated trials stay idempotent.
const planDigest = 'proc-claim-revision-v1-stable';
const result = {
  deterministic: true,
  plan_digest: planDigest,
  entry: declaredEntry,
  routeable: true,
};
writeFileSync(join(outputDir, 'procedure-result.json'), JSON.stringify(result));

// Trace proves the procedure stayed inside its declared entry and did not reach
// into a training/development partition.
const events = [
  { task_run_id: taskRunId, source: 'host', event: 'procedure.start', entry: declaredEntry },
  { task_run_id: taskRunId, source: 'host', event: 'procedure.entry', entry: declaredEntry },
  { task_run_id: taskRunId, source: 'host', event: 'procedure.finished', plan_digest: planDigest },
];
writeFileSync(tracePath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
