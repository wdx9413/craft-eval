/** Command line interface for local evaluation runs and comparisons. */

import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { auditSuiteFiles, coverageSuiteFiles } from './audit.js';
import { attributeRun } from './attribution.js';
import { compareRuns, loadSuite, reportRun, rescoreScripts, runSuite } from './evaluation.js';
import { runExperiment } from './experiment.js';
import { loadScenario, runScenario, scenarioCases } from './scenario.js';
import { writeHtmlReport } from './report-html.js';
import { runMutations } from './mutation.js';
import { calibrateJudge } from './calibration.js';

interface Options {
  [key: string]: string | number | boolean | undefined;
}

function parse(argv: string[]): { command: string; positional: string[]; options: Options } {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const options: Options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token.startsWith('--')) {
      const name = token.slice(2);
      if (name === 'trials') {
        const value = rest[index + 1];
        if (value === undefined) {
          throw new Error('--trials requires a value');
        }
        options.trials = Number(value);
        index += 1;
      } else if (name === 'parallelism') {
        const value = rest[index + 1];
        if (value === undefined) {
          throw new Error('--parallelism requires a value');
        }
        options.parallelism = Number(value);
        index += 1;
      } else if (name === 'fail-on-failed' || name === 'require-gain') {
        options[name] = true;
      } else if (name === 'workspace-mode') {
        const value = rest[index + 1];
        if (value === undefined) {
          throw new Error('--workspace-mode requires a value');
        }
        if (value !== 'isolated' && value !== 'shared') {
          throw new Error('--workspace-mode must be isolated or shared');
        }
        options.workspace_mode = value;
        index += 1;
      } else if (name === 'fail-fast') {
        options.fail_fast = true;
      } else if (name === 'workspace-source') {
        const value = rest[index + 1];
        if (value === undefined) {
          throw new Error('--workspace-source requires a value');
        }
        options.workspace_source = value;
        index += 1;
      } else if (name === 'keep-traces') {
        options.keep_traces = true;
      } else if (name === 'workspace' || name === 'output' || name === 'resume-after') {
        const value = rest[index + 1];
        if (value === undefined) {
          throw new Error(`--${name} requires a value`);
        }
        options[name] = value;
        index += 1;
      } else {
        throw new Error(`unrecognized argument: ${token}`);
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, options };
}

const USAGE = `usage: craft-eval <command> [options]

commands:
  validate <suite>
  audit <suite> [suite...]
  coverage <suite> [suite...]
  run <suite> <subject> <runtime> --workspace <dir> --output <dir> [--trials N] [--parallelism N] [--workspace-mode isolated|shared] [--fail-fast] [--workspace-source <dir>] [--keep-traces] [--fail-on-failed]
  report <run_dir>
  rescore <run_dir> --workspace <dir> --output <dir>
  compare <baseline> <candidate> [--require-gain]
  analyze <run_dir>
  report-html <run_dir> --output <file>
  experiment <manifest> --workspace <dir> --output <dir>
  mutation <manifest> <suite> <runtime> --workspace <dir> --output <dir>
  calibrate <manifest>
  scenario <scenario> [<subject> <runtime>] --workspace <dir> --output <dir> [--resume-after <step>]`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: { command: string; positional: string[]; options: Options };
  try {
    parsed = parse(argv);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ error: (error as Error).message }, null, 0) + '\n',
    );
    return 2;
  }
  const { command, positional, options } = parsed;
  try {
    let result: unknown;
    if (command === 'validate') {
      requireArgs(positional, 1, USAGE);
      const suite = await loadSuite(positional[0]!);
      result = { status: 'valid', suite_id: suite.suite_id, cases: suite.cases.length };
    } else if (command === 'audit') {
      requireArgs(positional, 1, USAGE);
      const audit = await auditSuiteFiles(positional);
      result = audit;
      if (audit.status === 'failed') {
        process.stdout.write(JSON.stringify(result) + '\n');
        return 1;
      }
    } else if (command === 'coverage') {
      requireArgs(positional, 1, USAGE);
      result = await coverageSuiteFiles(positional);
    } else if (command === 'run') {
      requireArgs(positional, 3, USAGE);
      if (options.workspace === undefined || options.output === undefined) {
        throw new Error('run requires --workspace and --output');
      }
      const path = await runSuite(positional[0]!, positional[1]!, positional[2]!, String(options.workspace), String(options.output), {
        trials: options.trials === undefined ? 1 : Number(options.trials),
        parallelism: options.parallelism === undefined ? 1 : Number(options.parallelism),
        workspace_mode: options.workspace_mode === undefined ? 'isolated' : (options.workspace_mode as 'isolated' | 'shared'),
        fail_fast: options.fail_fast === true,
        workspace_source: options.workspace_source === undefined ? undefined : String(options.workspace_source),
        keep_traces: options.keep_traces === true,
      });
      const report = await reportRun(path);
      result = { run_dir: path, report };
      if (
        options['fail-on-failed'] === true &&
        (report.failed > 0 || report.inconclusive > 0 || report.invalid > 0 || report.missing > 0)
      ) {
        process.stdout.write(JSON.stringify(result) + '\n');
        return 1;
      }
    } else if (command === 'report') {
      requireArgs(positional, 1, USAGE);
      result = await reportRun(positional[0]!);
    } else if (command === 'rescore') {
      requireArgs(positional, 1, USAGE);
      if (options.workspace === undefined || options.output === undefined) {
        throw new Error('rescore requires --workspace and --output');
      }
      const next = await rescoreScripts(positional[0]!, String(options.workspace), String(options.output));
      result = { run_dir: next, report: await reportRun(next) };
    } else if (command === 'compare') {
      requireArgs(positional, 2, USAGE);
      result = await compareRuns(positional[0]!, positional[1]!);
      if (options['require-gain'] === true && (result as { skill_gain_supported: boolean }).skill_gain_supported !== true) {
        process.stdout.write(JSON.stringify(result) + '\n');
        return 1;
      }
    } else if (command === 'analyze') {
      requireArgs(positional, 1, USAGE);
      result = attributeRun(await reportRun(positional[0]!));
    } else if (command === 'report-html') {
      requireArgs(positional, 1, USAGE);
      if (options.output === undefined) {
        throw new Error('report-html requires --output <file>');
      }
      const path = await writeHtmlReport(positional[0]!, String(options.output));
      result = { report: path };
    } else if (command === 'experiment') {
      requireArgs(positional, 1, USAGE);
      if (options.workspace === undefined || options.output === undefined) {
        throw new Error('experiment requires --workspace and --output');
      }
      result = await runExperiment(positional[0]!, {
        workspace: String(options.workspace),
        output: String(options.output),
      });
    } else if (command === 'mutation') {
      requireArgs(positional, 3, USAGE);
      if (options.workspace === undefined || options.output === undefined) {
        throw new Error('mutation requires --workspace and --output');
      }
      result = await runMutations(positional[0]!, positional[1]!, positional[2]!, String(options.workspace), String(options.output));
    } else if (command === 'calibrate') {
      requireArgs(positional, 1, USAGE);
      result = await calibrateJudge(positional[0]!);
    } else if (command === 'scenario') {
      requireArgs(positional, 1, USAGE);
      if (options.workspace === undefined || options.output === undefined) {
        throw new Error('scenario requires --workspace and --output');
      }
      const scenario = await loadScenario(positional[0]!);
      const cases = scenarioCases(scenario, {
        resumeAfter: options['resume-after'] === undefined ? undefined : String(options['resume-after']),
      });
      const output = String(options.output);
      const suitePath = resolve(output, `${scenario.scenario_id}.suite.json`);
      await mkdir(output, { recursive: true });
      await writeFile(
        suitePath,
        JSON.stringify({
          schema: 'craft-eval.eval.v1',
          suite_id: `${scenario.scenario_id}-scenario`,
          subject_kind: 'agent',
          partition: 'development',
          sanitized: true,
          cases,
        }),
        'utf8',
      );
      if (positional.length < 3) {
        result = {
          suite: suitePath,
          scenario_id: scenario.scenario_id,
          steps: cases.length,
          resume_after: options['resume-after'] ?? null,
        };
      } else {
        result = await runScenario(scenario, {
          subject: positional[1]!,
          runtime: positional[2]!,
          workspace: String(options.workspace),
          output,
          resumeAfter:
            options['resume-after'] === undefined ? undefined : String(options['resume-after']),
        });
      }
    } else {
      throw new Error(`unknown command: ${command}\n${USAGE}`);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: (error as Error).message }) + '\n');
    return 2;
  }
}

function requireArgs(positional: string[], count: number, usage: string): void {
  if (positional.length < count) {
    throw new Error(`missing arguments\n${usage}`);
  }
}

// Run only when invoked directly, never when imported by another module.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await main();
}
