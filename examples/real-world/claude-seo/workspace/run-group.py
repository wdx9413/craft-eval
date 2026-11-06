"""Run one group of claude-seo test files and summarize the result as JSON.

Usage: run-group.py <test file> [<test file> ...]

Writes outputs/group-result.json with the counts and the failing test names, so
a failing case points at concrete tests rather than "pytest failed".
"""
import json
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

REPO = Path(r"D:\documents\project\mytest\eval-subjects\claude-seo")
OUT = Path("outputs")
OUT.mkdir(exist_ok=True)
JUNIT = OUT / "group-junit.xml"

files = [f"tests/{name}" for name in sys.argv[1:]]
if not files:
    print("no test files given", file=sys.stderr)
    sys.exit(2)

proc = subprocess.run(
    [
        sys.executable, "-m", "pytest", *files,
        "-q", "--no-header", "-p", "no:cacheprovider",
        f"--junitxml={JUNIT.resolve()}",
    ],
    cwd=REPO,
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    timeout=280,
)

result = {
    "files": files,
    "exit_code": proc.returncode,
    "tests": 0,
    "failures": 0,
    "errors": 0,
    "skipped": 0,
    "ok": False,
    "failed_tests": [],
}
try:
    root = ET.parse(JUNIT).getroot()
    suite = root.find("testsuite") if root.tag == "testsuites" else root
    if suite is not None:
        result["tests"] = int(suite.get("tests", "0"))
        result["failures"] = int(suite.get("failures", "0"))
        result["errors"] = int(suite.get("errors", "0"))
        result["skipped"] = int(suite.get("skipped", "0"))
        for case in suite.iter("testcase"):
            if case.find("failure") is not None or case.find("error") is not None:
                result["failed_tests"].append(f"{case.get('classname', '')}::{case.get('name', '')}")
except Exception as exc:  # a missing report is itself a failure worth naming
    result["parse_error"] = str(exc)

result["ok"] = (
    result["tests"] > 0
    and result["failures"] == 0
    and result["errors"] == 0
    and "parse_error" not in result
)

print(json.dumps({k: result[k] for k in ("tests", "failures", "errors", "skipped", "ok")}))
if result["failed_tests"]:
    print("failed:", ", ".join(result["failed_tests"][:10]))

(OUT / "group-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
# The case verdict comes from the JSON checks, so a red group is reported there
# rather than as an adapter crash; exit 0 means "the run itself completed".
sys.exit(0)
