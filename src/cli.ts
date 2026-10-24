/** Command line interface for local evaluation runs and comparisons. */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compareRuns, loadSuite, reportRun, runSuite } from './evaluation.js';

interface Options {
  [key: string]: string | number | undefined;
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
      } else if (name === 'workspace' || name === 'output') {
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
  run <suite> <subject> <runtime> --workspace <dir> --output <dir> [--trials N]
  report <run_dir>
  compare <baseline> <candidate>`;

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
      const suite = await loadSuite(at(positional, 0));
      result = { status: 'valid', suite_id: suite.suite_id, cases: suite.cases.length };
    } else if (command === 'run') {
      requireArgs(positional, 3, USAGE);
      if (options.workspace === undefined || options.output === undefined) {
        throw new Error('run requires --workspace and --output');
      }
      const path = await runSuite(at(positional, 0), at(positional, 1), at(positional, 2), String(options.workspace), String(options.output), {
        trials: options.trials === undefined ? 1 : Number(options.trials),
      });
      result = { run_dir: path, report: await reportRun(path) };
    } else if (command === 'report') {
      requireArgs(positional, 1, USAGE);
      result = await reportRun(at(positional, 0));
    } else if (command === 'compare') {
      requireArgs(positional, 2, USAGE);
      result = await compareRuns(at(positional, 0), at(positional, 1));
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

function at(values: string[], index: number): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error('missing arguments');
  }
  return value;
}

// Run only when invoked directly, never when imported by another module.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await main();
}
