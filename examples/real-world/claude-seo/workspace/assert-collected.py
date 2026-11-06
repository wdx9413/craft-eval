"""Fail when a group collected no tests.

A group that silently matches nothing (renamed file, typo) would otherwise look
like a pass: zero failures, zero errors.
"""
import json
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "outputs/group-result.json")
if not path.exists():
    print(f"{path} missing")
    sys.exit(1)
data = json.loads(path.read_text(encoding="utf-8"))
tests = data.get("tests", 0)
print(f"collected={tests}")
sys.exit(0 if tests > 0 else 1)
