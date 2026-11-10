"""Run one craft-eval self-test by name from outside the repo.

The evaluator copies only the workspace, so the repo is entered explicitly and
node:test is invoked against the built test file with a name filter.
"""
import subprocess
import sys
from pathlib import Path

REPO = Path(r"D:\documents\project\mytest\craft-eval")
name = sys.argv[1]
proc = subprocess.run(
    ["node", "--test", "--test-name-pattern", f"^{name}$", "dist/tests/evaluation.test.js"],
    cwd=REPO,
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    timeout=170,
)
out = (proc.stdout or "") + (proc.stderr or "")
# node prints check marks; the console encoding here is GBK, so replace rather
# than crash while echoing the child's output.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stdout.write(out)
# node --test exits 0 when a filter matches nothing, so a zero-test run is a
# failure here: it means the named capability no longer exists.
if "tests 0" in out:
    print("no test matched the filter")
    sys.exit(1)
sys.exit(proc.returncode)
