export {
  SCHEMA,
  compareRuns,
  digest,
  loadSuite,
  reportRun,
  rescoreScripts,
  runSuite,
} from './evaluation.js';
export { auditSuites, auditSuiteFiles } from './audit.js';
export { prepareTaskInput, validateTaskContext } from './task-context.js';
export type { TaskContext, TaskInputReceipt } from './task-context.js';
export { attributeRun } from './attribution.js';
export {
  binaryEffect,
  pairedContinuousEffect,
  signProbability,
  summarizeContinuous,
} from './statistics.js';
export { experimentJobs, loadExperiment, runExperiment } from './experiment.js';
export {
  loadScenario,
  runScenario,
  scenarioCases,
  scenarioReport,
  writeScenarioReport,
} from './scenario.js';
export type {
  Case,
  CaseResult,
  CaseVerdict,
  Check,
  CheckResult,
  Comparison,
  HostConfig,
  HostObservation,
  MetricSummary,
  RunOptions,
  RunReport,
  Runtime,
  Subject,
  Suite,
  TriggerResult,
  Verdict,
} from './evaluation.js';
export type {
  AuditFinding,
  AuditSummary,
  AuditStatus,
  CaseAudit,
  SuiteAudit,
} from './audit.js';
export type {
  AttributionReport,
  FailureAttribution,
  FailureCategory,
} from './attribution.js';
export type {
  BinaryEffect,
  BinaryPair,
  ContinuousPair,
  ContinuousSummary,
  PairedContinuousEffect,
} from './statistics.js';
export type {
  ExperimentJob,
  ExperimentManifest,
  ExperimentOptions,
  ExperimentReport,
} from './experiment.js';
export type {
  Scenario,
  ScenarioAttempt,
  ScenarioCheckpoint,
  ScenarioReport,
  ScenarioRunOptions,
  ScenarioRunResult,
  ScenarioStep,
} from './scenario.js';
export type {
  CaseMetadata,
  CaseProvenance,
  Difficulty,
  EvaluationClaim,
  EvaluationMetrics,
  GuardrailDefinition,
  HostKind,
  MetricDefinition,
  MetricDirection,
  MetricKind,
  RiskLevel,
  SuiteMetadata,
  ToolBoundary,
} from './contract.js';

export { coverageSuiteFiles } from './audit.js';
export type { SuiteCoverage } from './audit.js';
export { writeHtmlReport } from './report-html.js';
export { runMutations } from './mutation.js';
export type { MutationSpec, MutationReport } from './mutation.js';
export { calibrateJudge } from './calibration.js';
export type { CalibrationManifest, CalibrationReport, CalibrationOptions } from './calibration.js';
