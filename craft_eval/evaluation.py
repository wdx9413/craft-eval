"""Run trusted local adapters and judge their observed effects.

Only the adapter command executes work. This module never runs a shell, model judge,
or promotion action. Cases and reports are JSON so other layers can use the same
contract without depending on Craft's storage or runtime.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = "craft-eval.eval.v1"
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RUNTIME_KEYS = ("environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest")
MAX_TRACE_BYTES = 1_000_000
MAX_JSON_BYTES = 1_000_000
MAX_CAPTURE_BYTES = 65_536


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_json_bytes(value)).hexdigest()


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _id(value: Any, name: str) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError(f"{name} must be a safe non-empty identifier")
    return value


def _relative(value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
        raise ValueError(f"{name} must be a relative path without '..'")
    return Path(value)


def _checks(value: Any, name: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError(f"{name} entries must be objects")
        check = dict(item)
        _id(check.get("id"), "check.id")
        kind = check.get("kind")
        if kind == "exit_code":
            if not isinstance(check.get("equals"), int) or isinstance(check["equals"], bool):
                raise ValueError("exit_code check requires integer equals")
        elif kind == "file_exists":
            _relative(check.get("path"), "file_exists.path")
        elif kind == "json_equals":
            _relative(check.get("path"), "json_equals.path")
            if not isinstance(check.get("key"), str) or not check["key"]:
                raise ValueError("json_equals requires a key")
            if "equals" not in check:
                raise ValueError("json_equals requires equals")
        elif kind == "trace_event":
            _id(check.get("event"), "trace_event.event")
            if not isinstance(check.get("present"), bool):
                raise ValueError("trace_event requires boolean present")
        else:
            raise ValueError(f"unsupported check kind: {kind}")
        result.append(check)
    ids = [item["id"] for item in result]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{name} check IDs must be unique")
    return result


def load_suite(path: str | Path) -> dict[str, Any]:
    suite = _load(Path(path))
    if suite.get("schema") != SCHEMA:
        raise ValueError(f"suite.schema must be {SCHEMA}")
    _id(suite.get("suite_id"), "suite_id")
    _id(suite.get("subject_kind"), "subject_kind")
    if suite.get("partition") not in ("development", "held_out"):
        raise ValueError("partition must be development or held_out")
    if suite.get("sanitized") is not True:
        raise ValueError("suite must be sanitized")
    if suite["partition"] == "held_out":
        _id(suite.get("approved_by"), "approved_by")
    cases = suite.get("cases")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 1_000:
        raise ValueError("suite needs 1..1000 cases")
    seen: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("case must be an object")
        case_id = _id(case.get("id"), "case.id")
        if case_id in seen:
            raise ValueError("case IDs must be unique")
        seen.add(case_id)
        argv = case.get("argv")
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or not arg for arg in argv):
            raise ValueError(f"case {case_id} needs non-empty argv strings")
        timeout = case.get("timeout_s", 30)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 3_600:
            raise ValueError(f"case {case_id} timeout_s must be within 0..3600")
        checks = _checks(case.get("checks", []), "checks")
        safety = _checks(case.get("safety_checks", []), "safety_checks")
        if set(check["id"] for check in checks) & set(check["id"] for check in safety):
            raise ValueError("task and safety check IDs must be distinct")
        if suite["subject_kind"] == "skill":
            if not isinstance(case.get("should_trigger"), bool):
                raise ValueError("Skill case requires should_trigger")
            _id(case.get("skill_id"), "skill_id")
            if case["should_trigger"] and not checks:
                raise ValueError("positive Skill case needs task checks")
        elif not checks:
            raise ValueError(f"case {case_id} needs task checks")
    return suite


def _subject(path: Path, kind: str) -> dict[str, Any]:
    subject = _load(path)
    if subject.get("kind") != kind:
        raise ValueError("subject kind differs from suite")
    _id(subject.get("id"), "subject.id")
    _id(subject.get("version"), "subject.version")
    env = subject.get("env", {})
    if not isinstance(env, dict) or any(not isinstance(key, str) or not ENV_KEY.fullmatch(key) or not isinstance(value, str)
                                        for key, value in env.items()):
        raise ValueError("subject.env must contain string environment variables")
    if any(key.startswith(("CRAFT_EVAL_", "DYLD_", "LD_")) for key in env):
        raise ValueError("subject.env cannot override evaluator controls")
    return subject


def _runtime(path: Path) -> dict[str, str]:
    value = _load(path)
    if set(value) != set(RUNTIME_KEYS) or any(not isinstance(value[key], str) or not value[key]
                                              for key in RUNTIME_KEYS):
        raise ValueError("runtime must pin environment, budget, host, model and tools digests")
    return value


def _atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_bytes(_json_bytes(value) + b"\n")
    os.replace(temporary, path)


def _workspace_copy(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise ValueError("workspace must be a directory")
    ignored = {".git", ".craft_data", ".venv", "__pycache__"}
    for root, dirs, files in os.walk(source):
        dirs[:] = [name for name in dirs if name not in ignored]
        if any((Path(root) / name).is_symlink() for name in dirs + files):
            raise ValueError("workspace cannot contain symlinks")
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(*ignored))


def _read_bounded(path: Path, maximum: int) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValueError(f"missing or oversized artifact: {path.name}")
    return path.read_bytes()


def _artifact(sandbox: Path, relative: Path) -> Path:
    target = sandbox / relative
    current = sandbox
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("artifact path crosses a symlink")
    if sandbox.resolve() not in target.resolve().parents:
        raise ValueError("artifact path leaves workspace")
    return target


def _trace(path: Path, task_run_id: str) -> tuple[list[dict[str, Any]], bool]:
    try:
        raw = _read_bounded(path, MAX_TRACE_BYTES)
        events = [json.loads(line) for line in raw.splitlines() if line.strip()]
    except (ValueError, OSError, json.JSONDecodeError):
        return [], False
    if not events or any(not isinstance(event, dict) or event.get("task_run_id") != task_run_id
                         or event.get("source") != "host" for event in events):
        return [], False
    return events, any(event.get("event") == "run.finished" for event in events)


def _check(check: dict[str, Any], sandbox: Path, exit_code: int | None,
           events: list[dict[str, Any]], terminal_trace: bool) -> dict[str, Any]:
    kind = check["kind"]
    evidence: dict[str, Any] = {"kind": kind}
    if kind == "exit_code":
        passed = exit_code == check["equals"] if exit_code is not None else None
        evidence["exit_code"] = exit_code
    elif kind == "file_exists":
        try:
            path = _artifact(sandbox, _relative(check["path"], "file_exists.path"))
            passed = path.is_file()
        except ValueError:
            passed = False
        evidence["path"] = check["path"]
    elif kind == "json_equals":
        try:
            path = _artifact(sandbox, _relative(check["path"], "json_equals.path"))
            value: Any = json.loads(_read_bounded(path, MAX_JSON_BYTES))
            for key in check["key"].split("."):
                value = value[key]
            passed = type(value) is type(check["equals"]) and value == check["equals"]
            evidence["artifact_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        except (ValueError, OSError, KeyError, IndexError, TypeError, json.JSONDecodeError):
            passed = False
        evidence["path"] = check["path"]
    else:
        passed = any(event.get("event") == check["event"] for event in events) == check["present"] if terminal_trace else None
        evidence["trace_complete"] = terminal_trace
    return {"id": check["id"], "passed": passed, "evidence": evidence}


def _verdict(results: list[dict[str, Any]]) -> str:
    if not results:
        return "inconclusive"
    if any(item["passed"] is False for item in results):
        return "failed"
    if any(item["passed"] is None for item in results):
        return "inconclusive"
    return "passed"


def _one_case(case: dict[str, Any], subject: dict[str, Any], workspace: Path,
              run_id: str, trial: int) -> dict[str, Any]:
    task_run_id = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="craft-eval-case-") as temporary:
        root = Path(temporary)
        sandbox = root / "workspace"
        _workspace_copy(workspace, sandbox)
        trace_path = root / "host-trace.jsonl"
        stdout_path, stderr_path = root / "stdout", root / "stderr"
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
        env.update({"HOME": str(root), "TMPDIR": str(root), "CRAFT_EVAL_RUN_ID": run_id,
                    "CRAFT_EVAL_TASK_RUN_ID": task_run_id, "CRAFT_EVAL_CASE_ID": case["id"],
                    "CRAFT_EVAL_TRIAL": str(trial), "CRAFT_EVAL_TRACE_PATH": str(trace_path),
                    "CRAFT_EVAL_OUTPUT_DIR": str(sandbox / "outputs")})
        env.update(subject.get("env", {}))
        (sandbox / "outputs").mkdir(exist_ok=True)
        started = time.monotonic()
        exit_code: int | None = None
        issue: str | None = None
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            try:
                process = subprocess.Popen(case["argv"], cwd=sandbox, env=env, stdout=stdout, stderr=stderr,
                                           start_new_session=True)
                try:
                    exit_code = process.wait(timeout=case.get("timeout_s", 30))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    issue = "timeout"
            except OSError as error:
                issue = f"adapter_error:{error.__class__.__name__}"
        duration_ms = round((time.monotonic() - started) * 1_000)
        events, terminal_trace = _trace(trace_path, task_run_id)
        task_checks = [_check(check, sandbox, exit_code, events, terminal_trace) for check in case.get("checks", [])]
        safety_checks = [_check(check, sandbox, exit_code, events, terminal_trace) for check in case.get("safety_checks", [])]
        trigger: dict[str, Any] | None = None
        if "should_trigger" in case:
            used = any(event.get("event") == "skill.invoked" and event.get("skill_id") == case["skill_id"] for event in events)
            trigger = {"expected": case["should_trigger"], "used": used if terminal_trace else None,
                       "verdict": ("passed" if used == case["should_trigger"] else "failed") if terminal_trace else "inconclusive"}
        task_verdict, safety_verdict = _verdict(task_checks), _verdict(safety_checks)
        verdict = "failed" if "failed" in (task_verdict, safety_verdict, trigger and trigger["verdict"]) else (
            "inconclusive" if issue or (task_verdict == "inconclusive" and not (trigger and trigger["verdict"] == "passed"))
            or safety_verdict == "inconclusive" and safety_checks or trigger and trigger["verdict"] == "inconclusive"
            else "passed")
        if issue:
            verdict = "inconclusive" if issue == "timeout" else "invalid"
        elif subject["kind"] == "agent" and not terminal_trace and verdict == "passed":
            verdict = "inconclusive"
        cost = next((event.get("cost_units") for event in reversed(events)
                     if event.get("event") == "run.finished" and isinstance(event.get("cost_units"), (int, float))
                     and not isinstance(event.get("cost_units"), bool) and math.isfinite(event["cost_units"])
                     and event["cost_units"] >= 0), None)
        return {"case_id": case["id"], "trial": trial, "task_run_id": task_run_id, "verdict": verdict,
                "task_verdict": task_verdict, "safety_verdict": safety_verdict if safety_checks else None,
                "trigger": trigger, "issue": issue, "exit_code": exit_code, "duration_ms": duration_ms,
                "cost_units": cost, "checks": task_checks, "safety_checks": safety_checks,
                "stdout_sha256": hashlib.sha256(stdout_path.read_bytes()).hexdigest(),
                "stderr_sha256": hashlib.sha256(stderr_path.read_bytes()).hexdigest(),
                "trace_sha256": hashlib.sha256(trace_path.read_bytes()).hexdigest() if trace_path.is_file() else None,
                "trace_complete": terminal_trace}


def run_suite(suite_path: str | Path, subject_path: str | Path, runtime_path: str | Path,
              workspace: str | Path, output_root: str | Path, trials: int = 1) -> Path:
    suite = load_suite(suite_path)
    subject = _subject(Path(subject_path), suite["subject_kind"])
    runtime = _runtime(Path(runtime_path))
    if isinstance(trials, bool) or not isinstance(trials, int) or not 1 <= trials <= 20:
        raise ValueError("trials must be 1..20")
    workspace_path = Path(workspace).resolve(strict=True)
    output = Path(output_root).resolve()
    if output == workspace_path or workspace_path in output.parents:
        raise ValueError("output must be outside workspace")
    output.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    run_dir = output / run_id
    run_dir.mkdir()
    (run_dir / "results").mkdir()
    plan = {"schema": SCHEMA, "run_id": run_id, "suite": suite, "suite_digest": _digest(suite),
            "subject": {"kind": subject["kind"], "id": subject["id"], "version": subject["version"],
                        "digest": _digest(subject)}, "runtime": runtime, "trials": trials,
            "expected": len(suite["cases"]) * trials}
    _atomic_json(run_dir / "plan.json", plan)
    for case in suite["cases"]:
        for trial in range(1, trials + 1):
            result = _one_case(case, subject, workspace_path, run_id, trial)
            _atomic_json(run_dir / "results" / f"{case['id']}-{trial}.json", result)
    return run_dir


def _run(path: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    root = Path(path)
    plan = _load(root / "plan.json")
    if plan.get("schema") != SCHEMA or _digest(plan.get("suite")) != plan.get("suite_digest"):
        raise ValueError("run plan is invalid or changed")
    results = []
    for case in plan["suite"]["cases"]:
        for trial in range(1, plan["trials"] + 1):
            result_path = root / "results" / f"{case['id']}-{trial}.json"
            if result_path.is_file():
                result = _load(result_path)
                if result.get("case_id") != case["id"] or result.get("trial") != trial:
                    raise ValueError("result does not match run plan")
                results.append(result)
            else:
                results.append({"case_id": case["id"], "trial": trial, "verdict": "missing",
                                "task_verdict": "missing", "safety_verdict": "missing", "task_run_id": None,
                                "trigger": None, "duration_ms": None, "cost_units": None})
    return plan, results


def report_run(path: str | Path) -> dict[str, Any]:
    plan, results = _run(path)
    counts = {kind: sum(item["verdict"] == kind for item in results)
              for kind in ("passed", "failed", "inconclusive", "invalid", "missing")}
    return {"run_id": plan["run_id"], "suite_id": plan["suite"]["suite_id"], "subject": plan["subject"],
            "partition": plan["suite"]["partition"], "expected": plan["expected"],
            "recorded": plan["expected"] - counts["missing"], **counts,
            "status": "complete" if not counts["missing"] and not counts["inconclusive"] and not counts["invalid"]
            else "incomplete", "results": results}


def _sign_probability(wins: int, losses: int) -> float | None:
    total = wins + losses
    if not total:
        return None
    probability = 0.0
    for successes in range(wins, total + 1):
        probability += math.exp(math.lgamma(total + 1) - math.lgamma(successes + 1)
                                - math.lgamma(total - successes + 1) - total * math.log(2))
    return min(1.0, probability)


def compare_runs(baseline_path: str | Path, candidate_path: str | Path) -> dict[str, Any]:
    baseline_plan, baseline = _run(baseline_path)
    candidate_plan, candidate = _run(candidate_path)
    if (baseline_plan["suite_digest"] != candidate_plan["suite_digest"] or
            baseline_plan["runtime"] != candidate_plan["runtime"] or
            baseline_plan["trials"] != candidate_plan["trials"] or
            baseline_plan["subject"]["kind"] != candidate_plan["subject"]["kind"]):
        raise ValueError("runs are not comparable")
    wins = losses = ties = unmeasured = 0
    cases_in_order = (case for case in baseline_plan["suite"]["cases"] for _ in range(baseline_plan["trials"]))
    for left, right, case in zip(baseline, candidate, cases_in_order):
        if not case.get("checks"):
            continue
        if left["task_verdict"] not in ("passed", "failed") or right["task_verdict"] not in ("passed", "failed"):
            unmeasured += 1
        elif left["task_verdict"] == right["task_verdict"]:
            ties += 1
        elif right["task_verdict"] == "passed":
            wins += 1
        else:
            losses += 1
    subject = baseline_plan["suite"]["subject_kind"]
    positive = sum(case.get("should_trigger") is True for case in baseline_plan["suite"]["cases"])
    negative = sum(case.get("should_trigger") is False for case in baseline_plan["suite"]["cases"])
    trigger_failures = sum(item["trigger"] is not None and item["trigger"]["verdict"] != "passed" for item in candidate)
    safety_failures = sum(item["safety_verdict"] == "failed" for item in candidate)
    run_ids = [item["task_run_id"] for item in baseline + candidate]
    independent = all(run_ids) and len(set(run_ids)) == len(run_ids)
    probability = _sign_probability(wins, losses)
    complete = not unmeasured and all(item["verdict"] not in ("missing", "inconclusive", "invalid") for item in baseline + candidate)
    gain = bool(subject == "skill" and baseline_plan["suite"]["partition"] == "held_out" and positive >= 20
                and negative >= 1 and complete and independent and not trigger_failures and not safety_failures
                and baseline_plan["subject"]["digest"] != candidate_plan["subject"]["digest"]
                and wins > losses and probability is not None and probability <= 0.05)
    def metric(items: list[dict[str, Any]], name: str) -> dict[str, Any]:
        values = [item[name] for item in items if isinstance(item[name], (int, float)) and not isinstance(item[name], bool)]
        return {"observed": len(values), "mean": sum(values) / len(values) if values else None}
    return {"status": "comparable" if complete else "inconclusive", "subject_kind": subject,
            "baseline_run_id": baseline_plan["run_id"], "candidate_run_id": candidate_plan["run_id"],
            "expected_pairs": len(baseline), "measured_pairs": wins + losses + ties, "unmeasured_pairs": unmeasured,
            "candidate_wins": wins, "baseline_wins": losses, "ties": ties, "one_sided_p": probability,
            "candidate_trigger_failures": trigger_failures, "candidate_safety_failures": safety_failures,
            "independent_task_runs": bool(independent), "skill_gain_supported": gain,
            "duration_ms": {"baseline": metric(baseline, "duration_ms"), "candidate": metric(candidate, "duration_ms")},
            "cost_units": {"baseline": metric(baseline, "cost_units"), "candidate": metric(candidate, "cost_units")}}
