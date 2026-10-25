import subprocess
import sys
import json
from pathlib import Path

repo = r"D:\documents\project\mytest\craft-eval"
# Step 1: build
build = subprocess.run(["cmd", "/c", "npm", "run", "build"], cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
# Step 2: run tests
tests = subprocess.run(["cmd", "/c", "npm", "test"], cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
text = tests.stdout + tests.stderr
import re
m = re.search(r"ℹ tests (\d+)", text)
total = int(m.group(1)) if m else 0
m_pass = re.search(r"ℹ pass (\d+)", text)
passed = int(m_pass.group(1)) if m_pass else 0
m_fail = re.search(r"ℹ fail (\d+)", text)
failed = int(m_fail.group(1)) if m_fail else 0
result = {
    "build_exit": build.returncode,
    "build_ok": build.returncode == 0,
    "tests": total,
    "passed": passed,
    "failed": failed,
    "all_pass": failed == 0 and total > 0,
    "tail": text[-300:],
}
print(f"CRAFT build={build.returncode} tests={total} pass={passed} fail={failed}")
Path("outputs").mkdir(exist_ok=True)
json.dump(result, open("outputs/craft-result.json", "w"), indent=2)
sys.exit(0)
