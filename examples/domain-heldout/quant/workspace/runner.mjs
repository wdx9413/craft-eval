import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The subject computes its record from a frozen out-of-sample panel: each
// signal trades the matching return, equity is the cumulative product, and
// max drawdown is the worst peak-to-trough drop. CRAFT_EVAL_CASE_ID can inject
// an inverted-signal degradation so the negative path is computed, not baked.
const outputDir = process.env.CRAFT_EVAL_OUTPUT_DIR;
if (!outputDir) throw new Error('CRAFT_EVAL_OUTPUT_DIR is required');
mkdirSync(outputDir, { recursive: true });
const panel = JSON.parse(readFileSync(join(import.meta.dirname, 'prices.json'), 'utf8'));
const degraded = process.env.CRAFT_EVAL_CASE_ID === 'quant-negative';
const perTrade = panel.returns.map((ret, index) => (degraded ? -1 : 1) * panel.signals[index] * ret);
let equity = 1;
let peak = 1;
let maxDrawdown = 0;
for (const gain of perTrade) {
  equity *= 1 + gain;
  peak = Math.max(peak, equity);
  maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
}
const result = {
  domain: 'quant',
  net_return: equity - 1,
  max_drawdown: maxDrawdown,
  out_of_sample: panel.out_of_sample,
  trades: perTrade.length,
};
writeFileSync(join(outputDir, 'result.json'), JSON.stringify(result));
