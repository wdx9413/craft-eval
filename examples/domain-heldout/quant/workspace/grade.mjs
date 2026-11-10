import { readFileSync } from 'node:fs';

// Deterministic quant grader: positive net return, drawdown within the frozen
// bound, evaluated on an out-of-sample partition with a minimum trade count.
const path = process.argv[2];
if (!path) { console.error('usage: grade.mjs <outputs/result.json>'); process.exit(2); }
const result = JSON.parse(readFileSync(path, 'utf8'));
if (result.domain !== 'quant') { console.error('wrong domain'); process.exit(1); }
if (!(result.net_return > 0)) { console.error(`net_return not positive: ${result.net_return}`); process.exit(1); }
if (!(result.max_drawdown <= 0.2)) { console.error(`drawdown exceeds 0.2: ${result.max_drawdown}`); process.exit(1); }
if (result.out_of_sample !== true) { console.error('not out-of-sample'); process.exit(1); }
if (!(result.trades >= 20)) { console.error(`too few trades: ${result.trades}`); process.exit(1); }
