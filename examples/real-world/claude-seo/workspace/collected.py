import json
import sys

data = json.load(open("outputs/pytest-result.json"))
tests = data.get("tests", 0)
print(f"tests_collected={tests}")
sys.exit(0 if tests > 200 else 1)
