// Deterministic checks for the loan-calculator MCP results.
import { readFileSync } from 'node:fs';

const result = JSON.parse(readFileSync('outputs/result.json', 'utf8'));
const failures = [];
if (result.init_ok !== true) failures.push('MCP initialize failed');
const caseId = process.env.CRAFT_EVAL_CASE_ID ?? '';
const paymentText = String(result.payment);

if (caseId === 'zero-rate') {
  // Boundary: 1,000,000 / 360 = 2777.78, no division by zero.
  if (!paymentText.includes('2777.78')) failures.push(`zero-rate payment mismatch: ${paymentText.slice(0, 160)}`);
} else if (caseId === 'negative-rate') {
  // Boundary: a negative rate must not produce NaN/Infinity.
  if (/nan|infinity/i.test(paymentText)) failures.push(`negative-rate produced ${paymentText.slice(0, 160)}`);
} else if (!paymentText.includes('4890.17')) {
  // Expected monthly payment for 1,000,000 @ 4.2% / 30y is 4890.17.
  failures.push(`payment mismatch: ${paymentText.slice(0, 160)}`);
}
if (!String(result.amort).includes('Year 1')) {
  failures.push('amortization output missing');
}
// Business invariants (see suite.business.invariants):
//  - inv-monthly-payment: the monthly payment formula is correct
//  - inv-amort-terminal-balance: a fully amortized loan must end at balance 0
//    and annual principal + interest must equal 12 monthly payments.
const amortText = String(result.amort);
if (caseId === 'amort-terminal') {
  // Invariant: the final year must end at (near) zero balance.
  const balances = [...amortText.matchAll(/balance \$([0-9.,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const last = balances.length === 0 ? null : balances[balances.length - 1];
  if (last === null || last > 1) failures.push(`inv-amort-terminal-balance: final balance ${last}`);
}
const yearOne = /Year 1: principal \$([0-9.,]+), interest \$([0-9.,]+)/.exec(amortText);
if (yearOne !== null && caseId !== 'negative-rate') {
  const principal = Number(yearOne[1].replace(/,/g, ''));
  const interest = Number(yearOne[2].replace(/,/g, ''));
  const annual = principal + interest;
  // Compare against the monthly payment for THIS case's rate, not a fixed one.
  const expectedMonthly = caseId === 'zero-rate' ? 2777.78 : 4890.17;
  const expectedAnnual = expectedMonthly * 12;
  if (Math.abs(annual - expectedAnnual) > 0.05) {
    failures.push(
      `inv-amort-terminal-balance: year 1 principal+interest ${annual.toFixed(2)} != 12 monthly payments ${expectedAnnual.toFixed(2)}`,
    );
  }
}
if (failures.length > 0) {
  console.error(failures.join('; '));
  process.exit(1);
}
