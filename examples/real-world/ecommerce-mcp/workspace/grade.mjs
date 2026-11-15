// Deterministic grader for the commerce MCP suite. Reads the observations the
// driver captured and asserts the business rule for the current case.
import { readFileSync } from 'node:fs';

const caseId = process.env.CRAFT_EVAL_CASE_ID ?? '';
const observations = JSON.parse(readFileSync('outputs/observations.json', 'utf8'));
const failures = [];

const expect = (condition, message) => { if (!condition) failures.push(message); };

if (caseId === 'product-query') {
  const product = observations.product?.payload ?? {};
  expect(observations.product?.is_error === false, 'product query errored');
  expect(product.sku === 'sku-tea', `unexpected sku: ${product.sku}`);
  expect(product.price === 120, `unexpected price: ${product.price}`);
} else if (caseId === 'coupon-threshold-199') {
  const quote = observations.quote?.payload ?? {};
  expect(quote.discount === 0, `199 did not reach the coupon threshold but discount=${quote.discount}`);
  expect(quote.total === 120, `unexpected total: ${quote.total}`);
} else if (caseId === 'coupon-threshold-200') {
  const quote = observations.quote?.payload ?? {};
  expect(quote.discount === 30, `exactly 200 must apply the coupon, discount=${quote.discount}`);
  expect(quote.total === 210, `unexpected total: ${quote.total}`);
} else if (caseId === 'coupon-threshold-201') {
  const quote = observations.quote?.payload ?? {};
  expect(quote.discount === 30, `201 must apply the coupon, discount=${quote.discount}`);
  expect(quote.total === 330, `unexpected total: ${quote.total}`);
} else if (caseId === 'order-create') {
  const order = observations.order?.payload ?? {};
  expect(observations.order?.is_error === false, 'order creation errored');
  expect(typeof order.order_id === 'string' && order.order_id.length > 0, 'order id missing');
  expect(order.remaining_stock === 1, `stock was not decremented: ${order.remaining_stock}`);
} else if (caseId === 'order-out-of-stock') {
  expect(observations.order?.is_error === true, 'out-of-stock order must fail');
  expect(observations.order?.payload?.error === 'out_of_stock', `unexpected error: ${observations.order?.payload?.error}`);
} else if (caseId === 'order-idempotent') {
  const first = observations.first?.payload ?? {};
  const second = observations.second?.payload ?? {};
  expect(first.order_id === second.order_id, `idempotent retry created ${second.order_id} instead of ${first.order_id}`);
  expect(second.replayed === true, 'retry was not reported as a replay');
}

if (failures.length > 0) {
  console.error(failures.join('; '));
  process.exit(1);
}
