import json
import os
import runpy
import sys
import tempfile
import unittest
import warnings
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from craft_eval import compare_runs, load_suite, report_run, run_suite
from craft_eval.cli import main
from craft_eval import evaluation as ev


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def runtime():
    return {key: key + "-fixed" for key in ("environment_digest", "budget_digest", "host_digest",
                                                 "model_digest", "tools_digest")}


def suite(kind, cases, partition="held_out"):
    return {"schema": "craft-eval.eval.v1", "suite_id": kind + "-suite", "subject_kind": kind,
            "partition": partition, "sanitized": True, "approved_by": "reviewer", "cases": cases}


def case(case_id, checks=None, safety=None, **extra):
    return {"id": case_id, "argv": [sys.executable, "host.py"], "timeout_s": 3,
            "checks": checks if checks is not None else [{"id": "exit", "kind": "exit_code", "equals": 0}],
            "safety_checks": safety if safety is not None else [], **extra}


class EvaluationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.output = self.root / "runs"
        self.runtime = write(self.root / "runtime.json", runtime())

    def project(self, script):
        (self.workspace / "host.py").write_text(script, encoding="utf-8")

    def run_eval(self, kind, cases, subject_env=None, trials=1):
        suite_path = write(self.root / f"{kind}-suite.json", suite(kind, cases))
        subject_path = write(self.root / f"{kind}-{len(list(self.output.glob('*'))) if self.output.exists() else 0}.json",
                             {"kind": kind, "id": kind + "-subject", "version": "v1", "env": subject_env or {}})
        return run_suite(suite_path, subject_path, self.runtime, self.workspace, self.output, trials)

    def test_software_executes_in_copy_and_reports_observed_failures(self):
        self.project("""from pathlib import Path
import json, os, sys
case = os.environ['CRAFT_EVAL_CASE_ID']
Path('outputs/state.json').write_text(json.dumps({'ok': case == 'fixed'}))
sys.exit(0 if case == 'fixed' else 3)
""")
        cases = [case("fixed", [{"id": "exit", "kind": "exit_code", "equals": 0},
                                {"id": "state", "kind": "json_equals", "path": "outputs/state.json", "key": "ok", "equals": True}],
                      [{"id": "artifact", "kind": "file_exists", "path": "outputs/state.json"}]),
                 case("broken")]
        run = self.run_eval("software", cases)
        report = report_run(run)
        self.assertEqual((report["expected"], report["recorded"], report["passed"], report["failed"]), (2, 2, 1, 1))
        self.assertEqual(report["status"], "complete")
        self.assertFalse((self.workspace / "outputs").exists())
        self.assertEqual(report["results"][0]["safety_verdict"], "passed")
        self.assertTrue(report["results"][0]["stdout_sha256"])
        with redirect_stdout(StringIO()):
            self.assertEqual(main(["validate", str(self.root / "software-suite.json")]), 0)
            self.assertEqual(main(["report", str(run)]), 0)

    def test_agent_checks_environment_state_and_completed_host_trace(self):
        self.project("""from pathlib import Path
import json, os
Path('outputs/result.json').write_text(json.dumps({'task': {'done': True}}))
trace = Path(os.environ['CRAFT_EVAL_TRACE_PATH'])
events = [{'source': 'host', 'task_run_id': os.environ['CRAFT_EVAL_TASK_RUN_ID'], 'event': 'tool.called'},
          {'source': 'host', 'task_run_id': os.environ['CRAFT_EVAL_TASK_RUN_ID'], 'event': 'run.finished', 'cost_units': 2.5}]
trace.write_text('\\n'.join(json.dumps(x) for x in events) + '\\n')
""")
        checks = [{"id": "result", "kind": "json_equals", "path": "outputs/result.json", "key": "task.done", "equals": True},
                  {"id": "tool", "kind": "trace_event", "event": "tool.called", "present": True}]
        run = self.run_eval("agent", [case("do-task", checks)])
        result = report_run(run)["results"][0]
        self.assertEqual((result["verdict"], result["task_verdict"], result["cost_units"], result["trace_complete"]),
                         ("passed", "passed", 2.5, True))

    def test_missing_terminal_trace_is_inconclusive_even_when_skill_not_selected(self):
        self.project("""from pathlib import Path
import json, os
Path(os.environ['CRAFT_EVAL_TRACE_PATH']).write_text(json.dumps({'source': 'host', 'task_run_id': os.environ['CRAFT_EVAL_TASK_RUN_ID'], 'event': 'started'})+'\\n')
""")
        run = self.run_eval("skill", [case("adjacent", [], should_trigger=False, skill_id="answer-skill")])
        result = report_run(run)["results"][0]
        self.assertEqual((result["verdict"], result["trigger"]["verdict"]), ("inconclusive", "inconclusive"))

    def test_agent_requires_completed_host_trace_even_for_file_checks(self):
        self.project("from pathlib import Path\nPath('outputs/result.json').write_text('{\"done\":true}')\n")
        checks = [{"id": "result", "kind": "json_equals", "path": "outputs/result.json", "key": "done", "equals": True}]
        run = self.run_eval("agent", [case("agent", checks)])
        result = report_run(run)["results"][0]
        self.assertEqual((result["task_verdict"], result["verdict"], result["trace_complete"]),
                         ("passed", "inconclusive", False))

    def test_skill_paired_gain_requires_positive_negative_and_real_distinct_runs(self):
        self.project("""from pathlib import Path
import json, os
enabled = os.environ.get('SKILL_ENABLED') == '1'
positive = os.environ['CRAFT_EVAL_CASE_ID'].startswith('task-')
Path('outputs/result.json').write_text(json.dumps({'ok': enabled if positive else True}))
events = []
if enabled and positive:
    events.append({'source': 'host', 'task_run_id': os.environ['CRAFT_EVAL_TASK_RUN_ID'], 'event': 'skill.invoked', 'skill_id': 'answer-skill'})
events.append({'source': 'host', 'task_run_id': os.environ['CRAFT_EVAL_TASK_RUN_ID'], 'event': 'run.finished', 'cost_units': 1})
Path(os.environ['CRAFT_EVAL_TRACE_PATH']).write_text('\\n'.join(json.dumps(event) for event in events)+'\\n')
""")
        checks = [{"id": "outcome", "kind": "json_equals", "path": "outputs/result.json", "key": "ok", "equals": True}]
        cases = [case(f"task-{index}", checks, should_trigger=True, skill_id="answer-skill") for index in range(20)]
        cases.append(case("adjacent", [], should_trigger=False, skill_id="answer-skill"))
        baseline = self.run_eval("skill", cases, {"SKILL_ENABLED": "0"})
        candidate = self.run_eval("skill", cases, {"SKILL_ENABLED": "1"})
        compared = compare_runs(baseline, candidate)
        self.assertEqual((compared["measured_pairs"], compared["candidate_wins"], compared["candidate_trigger_failures"]), (20, 20, 0))
        self.assertTrue(compared["skill_gain_supported"])
        self.assertLess(compared["one_sided_p"], 0.05)
        self.assertTrue(compared["independent_task_runs"])
        with redirect_stdout(StringIO()):
            self.assertEqual(main(["compare", str(baseline), str(candidate)]), 0)

    def test_plan_and_result_tampering_or_incomplete_work_cannot_pass(self):
        self.project("pass\n")
        run = self.run_eval("software", [case("one"), case("two")], trials=2)
        result_path = run / "results" / "one-1.json"
        result_path.unlink()
        report = report_run(run)
        self.assertEqual((report["missing"], report["status"]), (1, "incomplete"))
        other = self.run_eval("software", [case("one"), case("two")], trials=2)
        self.assertEqual(compare_runs(run, other)["status"], "inconclusive")
        changed = json.loads((run / "plan.json").read_text())
        changed["suite"]["cases"][0]["id"] = "different"
        write(run / "plan.json", changed)
        with self.assertRaisesRegex(ValueError, "invalid or changed"):
            report_run(run)

    def test_suite_validation_rejects_unsafe_or_ambiguous_contracts(self):
        base = suite("software", [case("a")])
        variants = [
            ({**base, "schema": "wrong"}, "schema"),
            ({**base, "sanitized": False}, "sanitized"),
            ({**base, "approved_by": ""}, "approved_by"),
            ({**base, "partition": "wrong"}, "partition"),
            ({**base, "cases": []}, "1..1000"),
            ({**base, "cases": [case("a"), case("a")]}, "unique"),
            ({**base, "cases": [case("../bad")]}, "identifier"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "file_exists", "path": "../secret"}])]}, "relative"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "unknown"}])]}, "unsupported"),
        ]
        for value, message in variants:
            with self.subTest(message=message):
                path = write(self.root / "invalid.json", value)
                with self.assertRaisesRegex(ValueError, message):
                    load_suite(path)
        bad_subject = write(self.root / "bad-subject.json", {"kind": "software", "id": "build", "version": "v1",
                                                              "env": {"CRAFT_EVAL_TASK_RUN_ID": "fake"}})
        good_suite = write(self.root / "valid.json", base)
        with self.assertRaisesRegex(ValueError, "override"):
            run_suite(good_suite, bad_subject, self.runtime, self.workspace, self.output)

    def test_runtime_mismatch_and_adapter_errors_are_explicit(self):
        self.project("pass\n")
        suite_path = write(self.root / "suite.json", suite("software", [case("one")]))
        subject_path = write(self.root / "subject.json", {"kind": "software", "id": "build", "version": "v1"})
        with self.assertRaisesRegex(ValueError, "outside workspace"):
            run_suite(suite_path, subject_path, self.runtime, self.workspace, self.workspace / "output")
        bad_runtime = write(self.root / "bad-runtime.json", {"model_digest": "only"})
        with self.assertRaisesRegex(ValueError, "runtime must pin"):
            run_suite(suite_path, subject_path, bad_runtime, self.workspace, self.output)
        missing_command = case("missing")
        missing_command["argv"] = ["/definitely/missing/craft-eval-adapter"]
        broken_suite = write(self.root / "broken-suite.json", suite("software", [missing_command]))
        run = run_suite(broken_suite, subject_path, self.runtime, self.workspace, self.output)
        self.assertEqual(report_run(run)["results"][0]["verdict"], "invalid")

    def test_timeout_and_untrusted_trace_cannot_count_as_success(self):
        self.project("import time\ntime.sleep(5)\n")
        slow = case("slow")
        slow["timeout_s"] = 0.05
        run = self.run_eval("software", [slow])
        result = report_run(run)["results"][0]
        self.assertEqual((result["issue"], result["verdict"]), ("timeout", "inconclusive"))
        self.project("""from pathlib import Path
import json, os
Path(os.environ['CRAFT_EVAL_TRACE_PATH']).write_text(json.dumps({'source':'agent','task_run_id':os.environ['CRAFT_EVAL_TASK_RUN_ID'],'event':'run.finished'})+'\\n')
""")
        run = self.run_eval("skill", [case("negative", [], should_trigger=False, skill_id="answer-skill")])
        self.assertEqual(report_run(run)["results"][0]["trigger"]["verdict"], "inconclusive")

    def test_artifact_symlinks_cannot_read_outside_workspace(self):
        outside = self.root / "secret.json"
        outside.write_text('{"safe":true}', encoding="utf-8")
        self.project("""from pathlib import Path
import os
Path('outputs/leak.json').symlink_to(os.environ['OUTSIDE_FILE'])
""")
        checks = [{"id": "leak", "kind": "json_equals", "path": "outputs/leak.json", "key": "safe", "equals": True}]
        run = self.run_eval("software", [case("leak", checks)], {"OUTSIDE_FILE": str(outside)})
        result = report_run(run)["results"][0]
        self.assertEqual((result["task_verdict"], result["checks"][0]["passed"]), ("failed", False))

    def test_contract_rejects_all_invalid_case_and_check_shapes(self):
        base = suite("software", [case("a")])
        variants = [
            ([], "JSON object"),
            ({**base, "cases": [None]}, "case must"),
            ({**base, "cases": [case("a", "bad")]}, "array"),
            ({**base, "cases": [case("a", [None])]}, "objects"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "exit_code", "equals": True}])]}, "integer"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "json_equals", "path": "result.json", "key": ""}])]}, "key"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "json_equals", "path": "result.json", "key": "a"}])]}, "equals"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "trace_event", "event": "done", "present": 1}])]}, "boolean"),
            ({**base, "cases": [case("a", [{"id": "x", "kind": "exit_code", "equals": 0}, {"id": "x", "kind": "exit_code", "equals": 1}])]}, "unique"),
            ({**base, "cases": [case("a", safety=[{"id": "exit", "kind": "exit_code", "equals": 0}])]}, "distinct"),
            ({**base, "cases": [{**case("a"), "argv": []}]}, "argv"),
            ({**base, "cases": [{**case("a"), "timeout_s": 0}]}, "timeout"),
            ({**base, "cases": [case("a", [])]}, "task checks"),
            ({**suite("skill", [case("a")])}, "should_trigger"),
            ({**suite("skill", [case("a", [], should_trigger=True, skill_id="x")])}, "positive"),
        ]
        for value, message in variants:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    load_suite(write(self.root / "bad.json", value))

    def test_subject_workspace_trials_and_cli_errors(self):
        self.project("pass\n")
        suite_path = write(self.root / "suite.json", suite("software", [case("a")]))
        valid = {"kind": "software", "id": "subject", "version": "v1"}
        for value, message in [({**valid, "kind": "agent"}, "kind"),
                               ({**valid, "env": []}, "env"),
                               ({**valid, "env": {"BAD-NAME": "x"}}, "env")]:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    run_suite(suite_path, write(self.root / "subject.json", value), self.runtime, self.workspace, self.output)
        subject_path = write(self.root / "subject.json", valid)
        for trials in (0, True, 21):
            with self.assertRaisesRegex(ValueError, "trials"):
                run_suite(suite_path, subject_path, self.runtime, self.workspace, self.output, trials)
        with self.assertRaisesRegex(ValueError, "workspace"):
            ev._workspace_copy(self.root / "missing", self.root / "copy")
        (self.workspace / "linked").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            run_suite(suite_path, subject_path, self.runtime, self.workspace, self.output)
        with redirect_stderr(StringIO()):
            self.assertEqual(main(["validate", str(self.root / "missing.json")]), 2)

    def test_artifact_and_trace_failure_modes(self):
        self.project("""from pathlib import Path
import os
Path('outputs/folder').mkdir()
Path('outputs/folder/result.json').write_text('{bad json')
Path('outputs/folder/linked.json').symlink_to('/tmp')
""")
        checks = [
            {"id": "missing", "kind": "file_exists", "path": "outputs/missing"},
            {"id": "bad", "kind": "json_equals", "path": "outputs/folder/result.json", "key": "x", "equals": True},
            {"id": "linked", "kind": "file_exists", "path": "outputs/folder/linked.json"},
            {"id": "no-trace", "kind": "trace_event", "event": "tool.called", "present": False},
        ]
        run = self.run_eval("software", [case("bad", checks)])
        result = report_run(run)["results"][0]
        self.assertEqual([check["passed"] for check in result["checks"]], [False, False, False, None])
        with self.assertRaisesRegex(ValueError, "leaves workspace"):
            ev._artifact(self.root, Path("../secret"))

    def test_comparison_guards_and_pair_directions(self):
        self.project("""import os, sys
case = os.environ['CRAFT_EVAL_CASE_ID']
enabled = os.environ.get('ENABLED') == '1'
sys.exit(0 if (case == 'gain' and enabled) or (case == 'loss' and not enabled) else 1)
""")
        cases = [case("gain"), case("loss")]
        baseline = self.run_eval("software", cases, {"ENABLED": "0"})
        candidate = self.run_eval("software", cases, {"ENABLED": "1"})
        result = compare_runs(baseline, candidate)
        self.assertEqual((result["candidate_wins"], result["baseline_wins"]), (1, 1))
        self.assertAlmostEqual(result["one_sided_p"], 0.75)
        changed = self.run_eval("software", [case("other")])
        with self.assertRaisesRegex(ValueError, "not comparable"):
            compare_runs(baseline, changed)
        self.assertIsNone(ev._sign_probability(0, 0))
        self.assertAlmostEqual(ev._sign_probability(0, 2), 1)
        tampered = candidate / "results" / "gain-1.json"
        data = json.loads(tampered.read_text())
        data["trial"] = 2
        write(tampered, data)
        with self.assertRaisesRegex(ValueError, "does not match"):
            compare_runs(baseline, candidate)

    def test_development_suite_and_command_entry_points(self):
        self.project("pass\n")
        suite_path = write(self.root / "development.json", suite("software", [case("one")], "development"))
        subject_path = write(self.root / "subject.json", {"kind": "software", "id": "build", "version": "v1"})
        self.assertEqual(load_suite(suite_path)["partition"], "development")
        output = StringIO()
        with redirect_stdout(output):
            self.assertEqual(main(["run", str(suite_path), str(subject_path), str(self.runtime),
                                   "--workspace", str(self.workspace), "--output", str(self.output)]), 0)
        run_dir = Path(json.loads(output.getvalue())["run_dir"])
        self.assertEqual(report_run(run_dir)["passed"], 1)
        with patch.object(sys, "argv", ["craft-eval", "validate", str(suite_path)]), redirect_stdout(StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                runpy.run_module("craft_eval.__main__", run_name="__main__")
        self.assertEqual(stopped.exception.code, 0)
        with patch.object(sys, "argv", ["craft-eval", "validate", str(suite_path)]), redirect_stdout(StringIO()), warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=".*craft_eval.cli.*sys.modules.*", category=RuntimeWarning)
            with self.assertRaises(SystemExit) as stopped:
                runpy.run_module("craft_eval.cli", run_name="__main__")
        self.assertEqual(stopped.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
