import subprocess
import sys
import json
from pathlib import Path

repo = r"D:\documents\project\mytest\eval-subjects\pocketflow"
proc = subprocess.run(
    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
    cwd=repo,
    capture_output=True,
    text=True,
    timeout=300,
)
text = proc.stdout + proc.stderr
# Parse unittest summary line: "Ran N tests in Xs" and "OK" / "FAILED (failures=N, errors=N)"
import re
m = re.search(r"Ran (\d+) tests in", text)
ran = int(m.group(1)) if m else 0
failed = 0
errors = 0
m_fail = re.search(r"failures=(\d+)", text)
m_err = re.search(r"errors=(\d+)", text)
if m_fail: failed = int(m_fail.group(1))
if m_err: errors = int(m_err.group(1))
ok = "OK" in text.splitlines()[-3:] if text else False
result = {
    "exit_code": proc.returncode,
    "tests": ran,
    "failures": failed,
    "errors": errors,
    "ok": ok and failed == 0 and errors == 0,
    "tail": text[-300:],
}
print(f"POCKETFLOW tests={ran} failures={failed} errors={errors}")
Path("outputs").mkdir(exist_ok=True)
json.dump(result, open("outputs/unittest-result.json", "w"), indent=2)
sys.exit(0)
