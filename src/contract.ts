/**
 * Evaluation-contract metadata shared by suites, reports and analysis.
 *
 * The contract describes what an evaluation is allowed to claim. It does not
 * grant release authority or replace deterministic checks.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type HostKind = 'codex' | 'claude' | 'local';
export type MetricKind = 'binary_pass_rate' | 'duration_ms' | 'cost_units' | 'custom';
export type MetricDirection = 'higher_is_better' | 'lower_is_better';

export interface EvaluationClaim {
  statement: string;
  scope: string;
  limitations?: string[];
}

export interface MetricDefinition {
  id: string;
  kind: MetricKind;
  direction: MetricDirection;
  description?: string;
  unit?: string;
  minimum_sample?: number;
}

export interface GuardrailDefinition {
  id: string;
  metric: string;
  comparator: 'lte' | 'gte';
  threshold: number;
  required?: boolean;
}

export interface EvaluationMetrics {
  primary: MetricDefinition;
  guardrails?: GuardrailDefinition[];
}

export interface CaseProvenance {
  source: string;
  independent_of_training?: boolean;
  reviewed_by?: string;
  source_digest?: string;
}

export interface ToolBoundary {
  allowed_hosts?: HostKind[];
  allowed_tools?: string[];
  forbidden_tools?: string[];
  /** Declarative only unless the subject provides an enforcing sandbox. */
  network?: 'allow' | 'deny' | 'unobserved';
}

export interface CaseMetadata {
  tags?: string[];
  category?: string;
  difficulty?: Difficulty;
  risk?: RiskLevel;
  provenance?: CaseProvenance;
  owner?: string;
  expected_behavior?: string;
  claim?: string;
}

export interface SuiteMetadata {
  claim?: EvaluationClaim;
  metrics?: EvaluationMetrics;
  owner?: string;
  source?: string;
  expires_at?: string;
  boundaries?: ToolBoundary;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOSTS = new Set<HostKind>(['codex', 'claude', 'local']);
const DIFFICULTIES = new Set<Difficulty>(['easy', 'medium', 'hard']);
const RISKS = new Set<RiskLevel>(['low', 'medium', 'high', 'critical']);
const METRIC_KINDS = new Set<MetricKind>(['binary_pass_rate', 'duration_ms', 'cost_units', 'custom']);
const DIRECTIONS = new Set<MetricDirection>(['higher_is_better', 'lower_is_better']);

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(value: Record<string, unknown>, name: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${name} contains unsupported field: ${unknown}`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2_000) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`${name} must be a safe identifier`);
  }
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function stringList(value: unknown, name: string, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} must be an array of at most ${maximum} strings`);
  }
  const values = value.map((item) => text(item, `${name} entry`));
  if (values.length !== new Set(values).size) {
    throw new Error(`${name} entries must be unique`);
  }
  return values;
}

function date(value: unknown, name: string): string {
  const result = text(value, name);
  if (!DATE.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  return result;
}

export function validateClaim(value: unknown, name = 'claim'): EvaluationClaim {
  const claim = object(value, name);
  allowedKeys(claim, name, ['statement', 'scope', 'limitations']);
  const result: EvaluationClaim = {
    statement: text(claim.statement, `${name}.statement`),
    scope: text(claim.scope, `${name}.scope`),
  };
  if (claim.limitations !== undefined) {
    result.limitations = stringList(claim.limitations, `${name}.limitations`, 32);
  }
  return result;
}

export function validateMetric(value: unknown, name = 'metric'): MetricDefinition {
  const metric = object(value, name);
  allowedKeys(metric, name, ['id', 'kind', 'direction', 'description', 'unit', 'minimum_sample']);
  if (!METRIC_KINDS.has(metric.kind as MetricKind)) {
    throw new Error(`${name}.kind is unsupported`);
  }
  if (!DIRECTIONS.has(metric.direction as MetricDirection)) {
    throw new Error(`${name}.direction is unsupported`);
  }
  const result: MetricDefinition = {
    id: identifier(metric.id, `${name}.id`),
    kind: metric.kind as MetricKind,
    direction: metric.direction as MetricDirection,
  };
  const description = optionalText(metric.description, `${name}.description`);
  const unit = optionalText(metric.unit, `${name}.unit`);
  if (description !== undefined) result.description = description;
  if (unit !== undefined) result.unit = unit;
  if (metric.minimum_sample !== undefined) {
    const sample = finite(metric.minimum_sample, `${name}.minimum_sample`);
    if (!Number.isInteger(sample) || sample < 0) {
      throw new Error(`${name}.minimum_sample must be a non-negative integer`);
    }
    result.minimum_sample = sample;
  }
  return result;
}

export function validateGuardrail(value: unknown, name = 'guardrail'): GuardrailDefinition {
  const guardrail = object(value, name);
  allowedKeys(guardrail, name, ['id', 'metric', 'comparator', 'threshold', 'required']);
  if (guardrail.comparator !== 'lte' && guardrail.comparator !== 'gte') {
    throw new Error(`${name}.comparator must be lte or gte`);
  }
  if (guardrail.required !== undefined && typeof guardrail.required !== 'boolean') {
    throw new Error(`${name}.required must be a boolean`);
  }
  const result: GuardrailDefinition = {
    id: identifier(guardrail.id, `${name}.id`),
    metric: identifier(guardrail.metric, `${name}.metric`),
    comparator: guardrail.comparator,
    threshold: finite(guardrail.threshold, `${name}.threshold`),
  };
  if (guardrail.required !== undefined) result.required = guardrail.required;
  return result;
}

export function validateMetrics(value: unknown, name = 'metrics'): EvaluationMetrics {
  const metrics = object(value, name);
  allowedKeys(metrics, name, ['primary', 'guardrails']);
  const result: EvaluationMetrics = {
    primary: validateMetric(metrics.primary, `${name}.primary`),
  };
  if (metrics.guardrails !== undefined) {
    if (!Array.isArray(metrics.guardrails) || metrics.guardrails.length > 32) {
      throw new Error(`${name}.guardrails must be an array of at most 32 entries`);
    }
    const guardrails = metrics.guardrails.map((item, index) =>
      validateGuardrail(item, `${name}.guardrails[${index}]`),
    );
    if (new Set(guardrails.map((item) => item.id)).size !== guardrails.length) {
      throw new Error(`${name}.guardrails IDs must be unique`);
    }
    result.guardrails = guardrails;
  }
  return result;
}

export function validateCaseProvenance(value: unknown, name = 'provenance'): CaseProvenance {
  const provenance = object(value, name);
  allowedKeys(provenance, name, ['source', 'independent_of_training', 'reviewed_by', 'source_digest']);
  if (
    provenance.independent_of_training !== undefined &&
    typeof provenance.independent_of_training !== 'boolean'
  ) {
    throw new Error(`${name}.independent_of_training must be a boolean`);
  }
  const result: CaseProvenance = {
    source: text(provenance.source, `${name}.source`),
  };
  if (provenance.independent_of_training !== undefined) {
    result.independent_of_training = provenance.independent_of_training;
  }
  const reviewedBy = optionalText(provenance.reviewed_by, `${name}.reviewed_by`);
  const sourceDigest = optionalText(provenance.source_digest, `${name}.source_digest`);
  if (reviewedBy !== undefined) result.reviewed_by = reviewedBy;
  if (sourceDigest !== undefined) result.source_digest = sourceDigest;
  return result;
}

export function validateCaseMetadata(value: unknown, name = 'case'): CaseMetadata {
  const item = object(value, name);
  allowedKeys(item, name, [
    'tags',
    'category',
    'difficulty',
    'risk',
    'provenance',
    'owner',
    'expected_behavior',
    'claim',
  ]);
  if (item.difficulty !== undefined && !DIFFICULTIES.has(item.difficulty as Difficulty)) {
    throw new Error(`${name}.difficulty is unsupported`);
  }
  if (item.risk !== undefined && !RISKS.has(item.risk as RiskLevel)) {
    throw new Error(`${name}.risk is unsupported`);
  }
  const result: CaseMetadata = {};
  if (item.tags !== undefined) result.tags = stringList(item.tags, `${name}.tags`, 32);
  const category = optionalText(item.category, `${name}.category`);
  const owner = optionalText(item.owner, `${name}.owner`);
  const expectedBehavior = optionalText(item.expected_behavior, `${name}.expected_behavior`);
  const claim = optionalText(item.claim, `${name}.claim`);
  if (category !== undefined) result.category = category;
  if (owner !== undefined) result.owner = owner;
  if (expectedBehavior !== undefined) result.expected_behavior = expectedBehavior;
  if (claim !== undefined) result.claim = claim;
  if (item.difficulty !== undefined) result.difficulty = item.difficulty as Difficulty;
  if (item.risk !== undefined) result.risk = item.risk as RiskLevel;
  if (item.provenance !== undefined) {
    result.provenance = validateCaseProvenance(item.provenance, `${name}.provenance`);
  }
  return result;
}

/**
 * Reject unknown case fields without treating declared metadata as unknown.
 * The execution layer owns the operational fields; the contract owns metadata.
 */
export function validateCaseKeys(value: Record<string, unknown>, name = 'case'): void {
  allowedKeys(value, name, [
    'id',
    'argv',
    'prompt',
    'timeout_s',
    'checks',
    'safety_checks',
    'skill',
    'mcp',
    'http_mock',
    'requires',
    'language',
    'threshold',
    'workspace',
    'in_place',
    'driver',
    'tags',
    'category',
    'difficulty',
    'risk',
    'provenance',
    'owner',
    'expected_behavior',
    'claim',
  ]);
}

export function validateToolBoundary(value: unknown, name = 'boundaries'): ToolBoundary {
  const boundary = object(value, name);
  allowedKeys(boundary, name, ['allowed_hosts', 'allowed_tools', 'forbidden_tools', 'network']);
  const result: ToolBoundary = {};
  if (boundary.allowed_hosts !== undefined) {
    if (!Array.isArray(boundary.allowed_hosts) || boundary.allowed_hosts.length === 0) {
      throw new Error(`${name}.allowed_hosts must be a non-empty array`);
    }
    const hosts = boundary.allowed_hosts.map((item) => {
      if (!HOSTS.has(item as HostKind)) {
        throw new Error(`${name}.allowed_hosts contains an unsupported host`);
      }
      return item as HostKind;
    });
    if (new Set(hosts).size !== hosts.length) {
      throw new Error(`${name}.allowed_hosts entries must be unique`);
    }
    result.allowed_hosts = hosts;
  }
  if (boundary.allowed_tools !== undefined) {
    result.allowed_tools = stringList(boundary.allowed_tools, `${name}.allowed_tools`, 128);
  }
  if (boundary.forbidden_tools !== undefined) {
    result.forbidden_tools = stringList(boundary.forbidden_tools, `${name}.forbidden_tools`, 128);
  }
  if (result.allowed_tools !== undefined && result.forbidden_tools !== undefined) {
    const allowed = new Set(result.allowed_tools);
    if (result.forbidden_tools.some((item) => allowed.has(item))) {
      throw new Error(`${name} cannot both allow and forbid the same tool`);
    }
  }
  if (boundary.network !== undefined && !['allow', 'deny', 'unobserved'].includes(String(boundary.network))) {
    throw new Error(`${name}.network must be allow, deny or unobserved`);
  }
  if (boundary.network !== undefined) {
    result.network = boundary.network as ToolBoundary['network'];
  }
  return result;
}

export function validateSuiteMetadata(value: Record<string, unknown>): SuiteMetadata {
  const result: SuiteMetadata = {};
  if (value.claim !== undefined) result.claim = validateClaim(value.claim, 'claim');
  if (value.metrics !== undefined) result.metrics = validateMetrics(value.metrics, 'metrics');
  const owner = optionalText(value.owner, 'owner');
  const source = optionalText(value.source, 'source');
  if (owner !== undefined) result.owner = owner;
  if (source !== undefined) result.source = source;
  if (value.expires_at !== undefined) result.expires_at = date(value.expires_at, 'expires_at');
  if (value.boundaries !== undefined) {
    result.boundaries = validateToolBoundary(value.boundaries, 'boundaries');
  }
  return result;
}
