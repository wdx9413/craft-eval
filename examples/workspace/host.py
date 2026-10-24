import json
import os
from pathlib import Path

Path(os.environ["CRAFT_EVAL_OUTPUT_DIR"]).mkdir(exist_ok=True)
positive = os.environ["CRAFT_EVAL_CASE_ID"] == "skill-positive"
skill_enabled = os.environ.get("SKILL_ENABLED") == "1"
Path(os.environ["CRAFT_EVAL_OUTPUT_DIR"], "result.json").write_text(
    json.dumps({"safe": True, "task_done": not positive or skill_enabled})
)
event_base = {"source": "host", "task_run_id": os.environ["CRAFT_EVAL_TASK_RUN_ID"]}
events = [{**event_base, "event": "tool.called"}]
if positive and skill_enabled:
    events.append({**event_base, "event": "skill.invoked", "skill_id": "example-skill"})
events.append({**event_base, "event": "run.finished", "cost_units": 1})
Path(os.environ["CRAFT_EVAL_TRACE_PATH"]).write_text("\n".join(json.dumps(event) for event in events) + "\n")
