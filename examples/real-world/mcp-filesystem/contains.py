"""Assert a JSON record field contains a substring.

Usage: contains.py <json-path> <record-key> <needle>

Kept generic so every "the tool said X" assertion reuses one script instead of
one bespoke file per case.
"""
import json
import sys
from pathlib import Path

if len(sys.argv) != 4:
    print("usage: contains.py <json-path> <record-key> <needle>", file=sys.stderr)
    sys.exit(2)

path, record, needle = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(Path(path).read_text(encoding="utf-8"))
entry = data.get(record)
if not isinstance(entry, dict):
    print(f"record {record!r} missing or not an object")
    sys.exit(1)
text = entry.get("text", "")
if needle in text:
    print(f"{record}.text contains {needle!r}")
    sys.exit(0)
print(f"{record}.text does not contain {needle!r}; got: {text[:200]!r}")
sys.exit(1)
