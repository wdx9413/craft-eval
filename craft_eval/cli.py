"""Command line interface for local evaluation runs and comparisons."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .evaluation import compare_runs, load_suite, report_run, run_suite


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="craft-eval")
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="validate a versioned evaluation suite")
    validate.add_argument("suite", type=Path)
    run = commands.add_parser("run", help="run trusted adapter commands in copied workspaces")
    run.add_argument("suite", type=Path)
    run.add_argument("subject", type=Path)
    run.add_argument("runtime", type=Path)
    run.add_argument("--workspace", type=Path, required=True)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--trials", type=int, default=1)
    report = commands.add_parser("report", help="report planned and observed cases")
    report.add_argument("run_dir", type=Path)
    compare = commands.add_parser("compare", help="compare two pinned runs")
    compare.add_argument("baseline", type=Path)
    compare.add_argument("candidate", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            suite = load_suite(args.suite)
            result = {"status": "valid", "suite_id": suite["suite_id"], "cases": len(suite["cases"])}
        elif args.command == "run":
            path = run_suite(args.suite, args.subject, args.runtime, args.workspace, args.output, args.trials)
            result = {"run_dir": str(path), "report": report_run(path)}
        elif args.command == "report":
            result = report_run(args.run_dir)
        else:
            result = compare_runs(args.baseline, args.candidate)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
