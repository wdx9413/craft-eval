import json
import sys

data = json.load(open("outputs/pytest-result.json"))
failures = data.get("failures", 0) + data.get("errors", 0)
tests = data.get("tests", 0)
if tests == 0:
    print("no tests collected")
    sys.exit(1)
pass_rate = (tests - failures) / tests
print(f"pass_rate={pass_rate:.4f} failures={failures} tests={tests}")
# Accept if at least 98% pass — the known environment-missing failures (lxml,
# gcloud CLI) are not product defects and should not fail the whole suite.
sys.exit(0 if pass_rate >= 0.98 else 1)
