import json
import sys

data = json.load(open("outputs/unittest-result.json"))
print(f"tests={data.get('tests', 0)} ok={data.get('ok')}")
sys.exit(0 if data.get("tests", 0) >= 30 and data.get("ok") else 1)
