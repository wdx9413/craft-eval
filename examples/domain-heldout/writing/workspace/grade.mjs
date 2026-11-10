import { readFileSync } from 'node:fs';

// Deterministic writing grader: every rubric dimension clears its frozen
// threshold, no forbidden claims, and the audience is matched. A calibrated
// judge may supply these numbers; an uncalibrated one may not promote.
const path = process.argv[2];
if (!path) { console.error('usage: grade.mjs <outputs/result.json>'); process.exit(2); }
const result = JSON.parse(readFileSync(path, 'utf8'));
if (result.domain !== 'writing') { console.error('wrong domain'); process.exit(1); }
const thresholds = { clarity: 0.8, factual_accuracy: 0.8, style_consistency: 0.8 };
for (const [dimension, minimum] of Object.entries(thresholds)) {
  const score = result.rubric?.[dimension];
  if (typeof score !== 'number' || !(score >= minimum)) {
    console.error(`rubric ${dimension} below ${minimum}: ${score}`); process.exit(1);
  }
}
if (result.forbidden_claims !== 0) { console.error(`forbidden claims: ${result.forbidden_claims}`); process.exit(1); }
if (result.audience_match !== true) { console.error('audience not matched'); process.exit(1); }
