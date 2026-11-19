#!/usr/bin/env python3
"""Run the full suite under a per-source-file 100% coverage gate.

The inventory comes from src/ itself: every non-declaration TypeScript file must
compile to dist/src and be passed to Node's coverage include. Node's own
--test-coverage-{lines,functions,branches}=100 thresholds are authoritative for
the percentages. The same raw V8 data is parsed only to name uncovered lines and
functions, so a failure is actionable rather than a bare percentage.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = ROOT / "src"
DIST_ROOT = ROOT / "dist"


@dataclass(frozen=True)
class Module:
    source: Path
    compiled: Path
    include: str


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def discover_modules() -> list[Module]:
    modules: list[Module] = []
    for source in sorted(SOURCE_ROOT.rglob("*.ts")):
        if source.name.endswith(".d.ts"):
            continue
        compiled = DIST_ROOT / source.relative_to(ROOT).with_suffix(".js")
        modules.append(Module(source, compiled, compiled.relative_to(ROOT).as_posix()))
    return modules


def discover_tests() -> list[Path]:
    return sorted(DIST_ROOT.glob("tests/*.test.js"))


def check_inventory(modules: list[Module], tests: list[Path]) -> list[str]:
    errors: list[str] = []
    if not modules:
        errors.append("no TypeScript sources found under src/")
    if not tests:
        errors.append("no compiled tests found at dist/tests/*.test.js")
    for module in modules:
        if not module.source.read_text(encoding="utf8").strip():
            errors.append(f"{relative(module.source)}: empty source counts as untested")
        if not module.compiled.is_file():
            errors.append(
                f"{relative(module.source)}: missing compiled module "
                f"{relative(module.compiled)}; run the build first"
            )
    return errors


def coverage_command(modules: list[Module], tests: list[Path]) -> list[str]:
    command = [
        "node",
        "--test",
        "--experimental-test-coverage",
        "--test-coverage-lines=100",
        "--test-coverage-functions=100",
        "--test-coverage-branches=100",
    ]
    command.extend(f"--test-coverage-include={module.include}" for module in modules)
    command.extend(relative(test) for test in tests)
    return command


def url_path(url: str) -> Path | None:
    parsed = urlparse(url)
    if parsed.netloc and parsed.netloc != "localhost":
        return None
    path = Path(unquote(parsed.path))
    if os.name == "nt":
        parts = path.parts
        if parts and len(parts) > 1 and len(parts[1]) == 2 and parts[1][1] == ":":
            return Path(f"{parts[1][0]}:/{'/'.join(parts[2:])}").resolve()
    return path.resolve()


def load_coverage(directory: Path, modules: list[Module]) -> dict[Path, dict[str, object]]:
    """Return raw per-script coverage, merged across every process that loaded it."""
    wanted = {module.compiled.resolve(): module for module in modules}
    scripts: dict[Path, dict[str, object]] = {}
    for entry in sorted(directory.glob("coverage-*.json")):
        try:
            data = json.loads(entry.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"cannot parse {entry}: {error}") from error
        for script in data.get("result", []):
            url = script.get("url", "")
            if not url.startswith("file://"):
                continue
            path = url_path(url)
            if path not in wanted:
                continue
            current = scripts.setdefault(path, {"functions": {}})
            functions: dict[tuple[str, int, int], list[dict[str, object]]] = current["functions"]  # type: ignore[assignment]
            for item in script.get("functions", []):
                ranges = item.get("ranges") or []
                if not ranges:
                    continue
                first = ranges[0]
                key = (str(item.get("functionName", "<anonymous>")), int(first["startOffset"]), int(first["endOffset"]))
                previous = functions.get(key)
                if previous is None or int(first["count"]) > int(previous[0]["count"]):
                    functions[key] = ranges
    return scripts


def line_starts(source: str) -> list[int]:
    starts = [0]
    for index, char in enumerate(source):
        if char == "\n":
            starts.append(index + 1)
    return starts


def line_at(starts: list[int], offset: int) -> int:
    low, high = 0, len(starts)
    position = max(0, min(offset, starts[-1]))
    while low < high:
        middle = (low + high) // 2
        if starts[middle] <= position:
            low = middle + 1
        else:
            high = middle
    return low


def merged_ranges(functions: dict[tuple[str, int, int], list[dict[str, object]]]) -> dict[tuple[int, int], int]:
    ranges: dict[tuple[int, int], int] = {}
    for entries in functions.values():
        for block in entries:
            key = (int(block["startOffset"]), int(block["endOffset"]))
            ranges[key] = max(ranges.get(key, 0), int(block["count"]))
    return ranges


def describe(module: Module, script: dict[str, object] | None) -> list[str]:
    name = relative(module.source)
    if script is None:
        return [f"{name}: module never loaded (include {module.include})"]
    source = module.compiled.read_text(encoding="utf8")
    starts = line_starts(source)
    functions: dict[tuple[str, int, int], list[dict[str, object]]] = script["functions"]  # type: ignore[assignment]
    uncovered_functions = [
        f"{key[0]}@{line_at(starts, key[1])}"
        for key, ranges in functions.items()
        if int(ranges[0]["count"]) == 0
    ]
    problems: list[str] = []
    if uncovered_functions:
        problems.append(f"{name}: uncovered functions {', '.join(sorted(uncovered_functions))}")
    # Node's own thresholds decide lines/branches; raw ranges identify the sites
    # the report cannot name. Every zero-count nested range is an uncovered branch.
    branches: list[int] = []
    for ranges in functions.values():
        for block in ranges[1:]:
            if int(block["count"]) == 0:
                branches.append(line_at(starts, int(block["startOffset"])))
    if branches:
        problems.append(f"{name}: uncovered branch sites at lines {', '.join(str(line) for line in sorted(set(branches)))}")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="print the inventory without running tests")
    parser.add_argument("--v8-dir", type=Path, help="analyse an existing NODE_V8_COVERAGE directory")
    parser.add_argument("--report", action="store_true", help="print gaps without failing")
    parser.add_argument("--tests", nargs="+", help="run only the named compiled test files")
    args = parser.parse_args(argv)
    modules = discover_modules()
    tests = discover_tests()
    errors = check_inventory(modules, tests)
    for module in modules:
        print(f"{relative(module.source)} -> {module.include}")
    print(f"inventory: {len(modules)} source modules, {len(tests)} compiled test files")
    if errors:
        for error in errors:
            print(f"FAIL {error}", file=sys.stderr)
        return 1
    if args.list:
        return 0
    if args.tests:
        wanted = {(ROOT / name).resolve() for name in args.tests}
        unknown = wanted - {test.resolve() for test in tests}
        if unknown:
            print(f"FAIL unknown compiled test {sorted(map(str, unknown))}", file=sys.stderr)
            return 1
        tests = [test for test in tests if test.resolve() in wanted]
    if args.v8_dir:
        scripts = load_coverage(args.v8_dir, modules)
        failures = [item for module in modules for item in describe(module, scripts.get(module.compiled.resolve()))]
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 0 if args.report or not failures else 1
    command = coverage_command(modules, tests)
    print("running: " + subprocess.list2cmdline(command))
    directory = Path(tempfile.mkdtemp(prefix="craft-eval-v8-"))
    environment = dict(os.environ)
    environment["NODE_V8_COVERAGE"] = str(directory)
    try:
        result = subprocess.run(command, cwd=ROOT, env=environment, check=False)
        scripts = load_coverage(directory, modules)
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    failures: list[str] = []
    if result.returncode != 0:
        failures.append(f"node coverage gate exited with {result.returncode}")
    for module in modules:
        failures.extend(describe(module, scripts.get(module.compiled.resolve())))
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 0 if args.report else 1
    print(f"coverage gate passed: {len(modules)} modules at 100% lines, branches and functions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
