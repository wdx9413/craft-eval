import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outputDir = process.env.CRAFT_EVAL_OUTPUT_DIR;
mkdirSync(outputDir, { recursive: true });
const positive = process.env.CRAFT_EVAL_CASE_ID === 'skill-positive';
const skillEnabled = process.env.SKILL_ENABLED === '1';
writeFileSync(join(outputDir, 'result.json'), JSON.stringify({ safe: true, task_done: !positive || skillEnabled }));
const base = { source: 'host', task_run_id: process.env.CRAFT_EVAL_TASK_RUN_ID };
const events = [{ ...base, event: 'tool.called' }];
if (positive && skillEnabled) {
  events.push({ ...base, event: 'skill.invoked', skill_id: 'example-skill' });
}
events.push({ ...base, event: 'run.finished', cost_units: 1 });
writeFileSync(process.env.CRAFT_EVAL_TRACE_PATH, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
