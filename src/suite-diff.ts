/**
 * Dataset lineage and version diffing for evaluation suites.
 *
 * Both functions are pure: they read a `Suite`'s declared `version` and
 * `parent_digest` defensively (the loader does not validate them yet) and never
 * mutate or execute anything.
 */

import { digest, type Case, type Suite } from './evaluation.js';

export const LINEAGE_SCHEMA = 'craft-eval.suite-lineage.v1';
export const DIFF_SCHEMA = 'craft-eval.suite-diff.v1';

export interface SuiteLineageEntry {
  suite_id: string;
  version: string | null;
  digest: string;
  parent_digest: string | null;
}

export interface SuiteLineage {
  schema: typeof LINEAGE_SCHEMA;
  suites: SuiteLineageEntry[];
}

export interface SuiteDiff {
  schema: typeof DIFF_SCHEMA;
  suite_id: string;
  before_digest: string;
  after_digest: string;
  parent_matches: boolean;
  added: Case[];
  removed: Case[];
  modified: Array<{ case_id: string; before: Case; after: Case }>;
}

/** Treat a malformed declaration as absent instead of trusting it. */
function declaredVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function declaredDigest(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('sha256:') ? value : null;
}

function isSuite(value: unknown): value is Suite {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Suite).suite_id === 'string';
}

function parentOf(suite: Suite): string | null {
  return declaredDigest(suite.parent_digest);
}

/** A suite's own content fingerprint: its digest without its `parent_digest` declaration. */
export function suiteContentDigest(suite: Suite): string {
  const content: Record<string, unknown> = { ...suite };
  // Copy so normalization below never touches the caller's suite.
  delete content.parent_digest;
  // In-memory spreads leave declared fields as explicit `undefined`; strip them so
  // the fingerprint matches the same suite parsed from a JSON file.
  for (const key of Object.keys(content)) {
    if (content[key] === undefined) {
      delete content[key];
    }
  }
  return digest(content);
}

/**
 * Lineage entries follow the input order so callers can pair an input suite with
 * its entry by index; the parent relation is carried by `parent_digest`.
 */
export function suiteLineage(suites: Suite[]): SuiteLineage {
  if (!Array.isArray(suites) || suites.some((item) => !isSuite(item))) {
    throw new Error('suiteLineage requires suites with a string suite_id');
  }
  const entries: SuiteLineageEntry[] = suites.map((suite) => ({
    suite_id: suite.suite_id,
    version: declaredVersion(suite.version),
    digest: suiteContentDigest(suite),
    parent_digest: parentOf(suite),
  }));
  return { schema: LINEAGE_SCHEMA, suites: entries };
}

export function diffSuites(oldSuite: Suite, newSuite: Suite): SuiteDiff {
  if (!isSuite(oldSuite) || !isSuite(newSuite)) {
    throw new Error('diffSuites requires suites with a string suite_id');
  }
  const before = new Map(oldSuite.cases.map((item) => [item.id, item]));
  const after = new Map(newSuite.cases.map((item) => [item.id, item]));
  const added: Case[] = [];
  const removed: Case[] = [];
  const modified: SuiteDiff['modified'] = [];
  for (const item of newSuite.cases) {
    const previous = before.get(item.id);
    if (previous === undefined) {
      added.push(item);
    } else if (digest(previous) !== digest(item)) {
      modified.push({ case_id: item.id, before: previous, after: item });
    }
  }
  for (const item of oldSuite.cases) {
    if (!after.has(item.id)) {
      removed.push(item);
    }
  }
  return {
    schema: DIFF_SCHEMA,
    suite_id: newSuite.suite_id,
    before_digest: suiteContentDigest(oldSuite),
    after_digest: suiteContentDigest(newSuite),
    parent_matches: parentOf(newSuite) === suiteContentDigest(oldSuite),
    added,
    removed,
    modified,
  };
}
