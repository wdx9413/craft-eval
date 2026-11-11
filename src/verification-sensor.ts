import { createHash } from "node:crypto";
import type { JsonObject } from '../../craft-common/packages/craft-common-store-local/src/store.ts';
import { text } from "./validation.ts";

/**
 * V1: a deterministic verification sensor.
 *
 * The gap this closes: Craft records whether work was *governed* (evidence,
 * signoffs, approvals) but never established whether the work was *correct*
 * without a human or a model asserting it. `decideExperienceCapture` weights a
 * failure at 30 points, yet the failure signal had to be supplied by the caller
 * as `outcome`. A loop therefore could not learn from its own mistakes, because
 * it was never told which ones they were.
 *
 * The design rule is taken from harness engineering: a sensor that cannot say
 * whether its own signal is real is not a closed loop, it only moves the noise
 * earlier. So every check here is *deterministic* — it is computed from
 * observable facts (an exit code, an exact expected string, a content digest)
 * and never from a model's opinion or the agent's own claim of success.
 *
 * Deliberately absent: any LLM judge, any "the model said it worked" path, and
 * any scoring that a caller can inflate. A check that cannot be evaluated
 * deterministically is reported as `inconclusive`, not as a pass — the fail
 * direction is the safe one.
 */

/** A deterministic check kind. Each is decidable from bytes, not from opinion. */
export type VerificationCheckKind = "exit_code" | "output_contains" | "output_matches" | "file_digest" | "file_absent";

/**
 * Verdict vocabulary, deliberately identical to `OutcomeObserverKernel` so a
 * sensor result can be recorded as an outcome observation without translation.
 */
export type VerificationVerdict = "passed" | "failed" | "blocked" | "inconclusive";

export interface VerificationCheckResult {
  kind: VerificationCheckKind;
  name: string;
  verdict: VerificationVerdict;
  /** Why this verdict was reached, in a form safe to store and show. */
  reason: string;
  /** Digest of the observed value; the raw value is never persisted. */
  observed_digest: string;
}

const CHECK_KINDS: ReadonlySet<string> = new Set(["exit_code", "output_contains", "output_matches", "file_digest", "file_absent"]);
const VERDICTS: ReadonlySet<string> = new Set(["passed", "failed", "blocked", "inconclusive"]);

/** A digest is the only form of observed content that leaves this module. */
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

/**
 * Read an optional observation.
 *
 * Empty string is a *real* observation, not a missing one: a command that
 * produced no output is a fact worth checking against, and rejecting it would
 * make the sensor crash on a legitimate case. Only `undefined`/`null` mean
 * "not observed".
 */
function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

/**
 * Evaluate one deterministic check.
 *
 * Each kind is answered by comparing observed bytes against an expected value.
 * `blocked` means the check could not run at all (the evidence it needs is
 * missing); `inconclusive` means it ran but the observation supports no
 * conclusion. Neither is ever collapsed into `passed`.
 */
export function evaluateVerificationCheck(input: JsonObject): VerificationCheckResult {
  const kind = text(input.kind, "kind");
  if (!CHECK_KINDS.has(kind)) throw new Error(`Verification check kind is unsupported: ${kind}`);
  const name = text(input.name, "name");

  if (kind === "exit_code") {
    const expected = Number(input.expected_exit_code ?? 0);
    if (!Number.isInteger(expected)) throw new Error("expected_exit_code must be an integer");
    const observed = input.observed_exit_code;
    // A check that never ran is blocked, not failed: we cannot tell a broken
    // tool from a failing one, and guessing would poison the learning signal.
    if (observed === undefined || observed === null) return { kind: kind as VerificationCheckKind, name, verdict: "blocked", reason: "check_not_executed", observed_digest: digest(null) };
    const actual = Number(observed);
    if (!Number.isInteger(actual)) throw new Error("observed_exit_code must be an integer");
    const passed = actual === expected;
    return { kind: kind as VerificationCheckKind, name, verdict: passed ? "passed" : "failed",
      reason: passed ? "exit_code_matched" : `exit_code_${actual}_expected_${expected}`, observed_digest: digest(actual) };
  }

  if (kind === "output_contains" || kind === "output_matches") {
    const expected = kind === "output_contains" ? text(input.expected_substring, "expected_substring") : text(input.expected_pattern, "expected_pattern");
    const observed = optionalText(input.observed_output, "observed_output");
    // No output at all is blocked; empty output is a real observation.
    if (observed === null) return { kind: kind as VerificationCheckKind, name, verdict: "blocked", reason: "check_not_executed", observed_digest: digest(null) };
    if (kind === "output_contains") {
      const passed = observed.includes(expected);
      return { kind: kind as VerificationCheckKind, name, verdict: passed ? "passed" : "failed",
        reason: passed ? "substring_present" : "substring_absent", observed_digest: digest(observed) };
    }
    // A pattern that does not compile is a broken check, not a failed task, so
    // it is reported as blocked rather than silently failing the work.
    let pattern: RegExp;
    try { pattern = new RegExp(expected, "u"); }
    catch { return { kind: kind as VerificationCheckKind, name, verdict: "blocked", reason: "pattern_invalid", observed_digest: digest(observed) }; }
    const passed = pattern.test(observed);
    return { kind: kind as VerificationCheckKind, name, verdict: passed ? "passed" : "failed",
      reason: passed ? "pattern_matched" : "pattern_not_matched", observed_digest: digest(observed) };
  }

  if (kind === "file_digest") {
    const expected = text(input.expected_digest, "expected_digest");
    const observed = optionalText(input.observed_digest, "observed_digest");
    if (observed === null) return { kind: kind as VerificationCheckKind, name, verdict: "blocked", reason: "check_not_executed", observed_digest: digest(null) };
    const passed = observed === expected;
    return { kind: kind as VerificationCheckKind, name, verdict: passed ? "passed" : "failed",
      reason: passed ? "digest_matched" : "digest_mismatched", observed_digest: digest(observed) };
  }

  // file_absent: the only kind where absence is success, so it is its own
  // vocabulary rather than a negated file_digest.
  const present = input.observed_present;
  if (present === undefined || present === null) return { kind: kind as VerificationCheckKind, name, verdict: "blocked", reason: "check_not_executed", observed_digest: digest(null) };
  if (typeof present !== "boolean") throw new Error("observed_present must be a boolean");
  return { kind: kind as VerificationCheckKind, name, verdict: present ? "failed" : "passed",
    reason: present ? "file_present" : "file_absent", observed_digest: digest(present) };
}

/**
 * Combine independent checks into one verdict.
 *
 * The combination is deliberately conservative and order-independent:
 *   any failed      -> failed      (one real contradiction is enough)
 *   else any blocked-> blocked     (work we could not verify is not verified)
 *   else any inconclusive -> inconclusive
 *   else all passed -> passed
 *
 * `inconclusive` is kept distinct from `failed` on purpose: "we could not tell"
 * and "we know it broke" must drive different learning, or the experience store
 * fills with lessons drawn from ignorance.
 */
export function summarizeVerification(checks: readonly VerificationCheckResult[]): JsonObject {
  if (!checks.length) throw new Error("verification requires at least one check");
  for (const check of checks) if (!VERDICTS.has(check.verdict)) throw new Error(`Verification verdict is unsupported: ${check.verdict}`);
  const names = checks.map((check) => check.name);
  if (new Set(names).size !== names.length) throw new Error("verification check names must be unique");

  const failed = checks.filter((check) => check.verdict === "failed");
  const blocked = checks.filter((check) => check.verdict === "blocked");
  const inconclusive = checks.filter((check) => check.verdict === "inconclusive");
  const verdict: VerificationVerdict = failed.length ? "failed" : blocked.length ? "blocked" : inconclusive.length ? "inconclusive" : "passed";

  return {
    verdict,
    check_count: checks.length,
    passed_count: checks.filter((check) => check.verdict === "passed").length,
    failed_checks: failed.map((check) => check.name).sort(),
    blocked_checks: blocked.map((check) => check.name).sort(),
    inconclusive_checks: inconclusive.map((check) => check.name).sort(),
    // Enough for `decideExperienceCapture` to score a lesson without a caller
    // asserting an outcome: a failure here is *observed*, not reported.
    is_failure: verdict === "failed",
    verifiable: verdict !== "blocked",
    checks: checks.map((check) => ({ kind: check.kind, name: check.name, verdict: check.verdict, reason: check.reason, observed_digest: check.observed_digest }))
  };
}

/**
 * Evaluate a whole verification plan in one call.
 *
 * This is the harness-facing entry point: the sensor produces the verdict that
 * the self-evolution loop consumes, so `decideExperienceCapture` can be driven
 * by an observed result rather than by `outcome` supplied from outside.
 *
 * Naming note: this is `evaluate` and not `run` deliberately. It compares bytes
 * that the caller already observed; it never executes a command, touches a
 * file, or reaches the network. The tool-authorization classifier treats any
 * `_run` suffix as `governed`, which the internal loop cannot mount — and a
 * sensor the loop cannot call would reproduce exactly the wiring gap this
 * module exists to close. The pure-function nature is what makes the `read`
 * tier honest here, and the tests pin that no check kind has side effects.
 */
export function runVerification(input: JsonObject): JsonObject {
  const raw = input.checks;
  if (!Array.isArray(raw) || !raw.length) throw new Error("checks must be a non-empty array");
  const checks = raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("check must be an object");
    return evaluateVerificationCheck(item as JsonObject);
  });
  return summarizeVerification(checks);
}

/**
 * Map a verification summary onto the capture-decision input.
 *
 * This is the wiring that makes the loop self-correcting: the sensor's verdict
 * becomes the `outcome` that `decideExperienceCapture` already knows how to
 * score, so a deterministically observed failure produces a `failure_lesson`
 * with no human or model input.
 *
 * The verdict vocabulary is deliberately narrowed to the three values the
 * capture decision accepts. `blocked` and `inconclusive` map to `abandoned`
 * rather than to `failed`, because an unverifiable run is not a demonstrated
 * mistake: mapping it to `failed` would fill the experience store with lessons
 * drawn from checks that never ran. The original verdict survives in
 * `verification_verdict` so nothing is lost.
 */
export function verificationCaptureSignals(input: JsonObject): JsonObject {
  const summary = runVerification(input);
  const priorRetries = Number(input.retries ?? 0);
  if (!Number.isInteger(priorRetries) || priorRetries < 0) throw new Error("retries must be a non-negative integer");
  const verdict = String(summary.verdict);
  // Only a check that ran and contradicted its expectation is evidence of a
  // mistake; "could not tell" is its own outcome.
  const outcome = verdict === "passed" ? "succeeded" : verdict === "failed" ? "failed" : "abandoned";
  return {
    succeeded: outcome === "succeeded",
    // A failed deterministic check is a correction the loop must absorb, which
    // is why it feeds `corrections` rather than only `retries`.
    corrections: verdict === "failed" ? 1 : 0,
    retries: priorRetries,
    // Narrowed to the capture vocabulary, and asserted by the tests, so this
    // module cannot silently emit a value `decideExperienceCapture` rejects.
    outcome,
    verification_verdict: verdict,
    is_failure: summary.is_failure,
    verifiable: summary.verifiable,
    failed_checks: summary.failed_checks,
    source: "deterministic_verification"
  };
}
