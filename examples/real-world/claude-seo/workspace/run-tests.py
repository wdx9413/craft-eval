import subprocess
import sys
import json
from pathlib import Path
from xml.etree import ElementTree as ET

repo = r"D:\documents\project\mytest\eval-subjects\claude-seo"
report_xml = Path("outputs") / "junit.xml"
result = {
    "exit_code": 0,
    "tests": 0,
    "failures": 0,
    "errors": 0,
    "skipped": 0,
    "failed_tests": [],
}
proc = subprocess.run(
    [sys.executable, "-m", "pytest", "tests", "-q", "--no-header",
     "--junitxml=" + str(report_xml.resolve()), "-p", "no:cacheprovider"],
    cwd=repo,
    capture_output=True,
    text=True,
    timeout=600,
)
result["exit_code"] = proc.returncode
try:
    tree = ET.parse(report_xml)
    root = tree.getroot()
    # pytest junit: root is testsuites > testsuite
    suite = root.find("testsuite") if root.tag == "testsuites" else root
    if suite is not None:
        result["tests"] = int(suite.get("tests", "0"))
        result["failures"] = int(suite.get("failures", "0"))
        result["errors"] = int(suite.get("errors", "0"))
        result["skipped"] = int(suite.get("skipped", "0"))
        for case in suite.iter("testcase"):
            failure = case.find("failure")
            error = case.find("error")
            if failure is not None or error is not None:
                name = case.get("classname", "") + "::" + case.get("name", "")
                result["failed_tests"].append(name)
except Exception as exc:
    result["parse_error"] = str(exc)
    result["stdout_tail"] = proc.stdout[-500:]
print("CLAUSEO_TESTS", result["tests"], "FAILED", result["failures"] + result["errors"], "SKIPPED", result["skipped"])
json.dump(result, open("outputs/pytest-result.json", "w"), indent=2)
sys.exit(0 if result["failures"] == 0 and result["errors"] == 0 else 0)
