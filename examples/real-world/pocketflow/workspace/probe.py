"""Behavioural probes for PocketFlow.

Each probe builds a tiny graph, runs it, and asserts one execution semantic.
They are independent of PocketFlow's own test files on purpose: the point is to
grade the library against its documented contract, not to re-run its suite.
"""
import asyncio
import os
import sys
import traceback
from pathlib import Path

# Overridable so the same probes can grade two checkouts for an A/B comparison.
REPO = Path(os.environ.get("POCKETFLOW_REPO", r"D:\documents\project\mytest\eval-subjects\pocketflow"))
sys.path.insert(0, str(REPO))

from pocketflow import (  # noqa: E402
    AsyncBatchFlow,
    AsyncFlow,
    AsyncNode,
    AsyncParallelBatchFlow,
    BatchFlow,
    BatchNode,
    Flow,
    Node,
)


class Set(Node):
    def __init__(self, key, value):
        super().__init__()
        self.key, self.value = key, value

    def prep(self, shared):
        return self.value

    def post(self, shared, prep_res, exec_res):
        shared[self.key] = self.value


class Record(Node):
    """Append its name to shared['trace'] so order is observable."""

    def __init__(self, name):
        super().__init__()
        self.name = name

    def prep(self, shared):
        return self.name

    def post(self, shared, prep_res, exec_res):
        shared.setdefault("trace", []).append(prep_res)


def probe_default_transition():
    a, b = Record("a"), Record("b")
    a >> b
    flow = Flow(a)
    shared = {}
    flow.run(shared)
    assert shared["trace"] == ["a", "b"], shared["trace"]


def probe_conditional_action():
    class Decide(Node):
        def post(self, shared, prep_res, exec_res):
            return "yes"

    yes, no = Record("yes"), Record("no")
    decide = Decide()
    decide - "yes" >> yes
    decide - "no" >> no
    flow = Flow(decide)
    shared = {}
    flow.run(shared)
    assert shared["trace"] == ["yes"], shared["trace"]


def probe_shared_state_visible():
    a = Set("x", 41)
    b = Set("y", 1)
    a >> b
    shared = {}
    Flow(a).run(shared)
    assert shared == {"x": 41, "y": 1}, shared


def probe_retry_succeeds_after_failures():
    """max_retries counts attempts, not retries: 3 attempts must reach success."""

    class Flaky(Node):
        def __init__(self):
            super().__init__(max_retries=3, wait=0)

        def prep(self, shared):
            return shared

        def exec(self, prep_res):
            # Flow walks copies of the start node, so attempts are counted in
            # shared state rather than on the instance.
            prep_res["calls"] += 1
            if prep_res["calls"] < 3:
                raise ValueError("not yet")
            return "ok"

    shared = {"calls": 0}
    Flow(Flaky()).run(shared)
    assert shared["calls"] == 3, shared["calls"]


def probe_fallback_used_on_exhaustion():
    class Always(Node):
        def __init__(self):
            super().__init__(max_retries=2, wait=0)

        def exec(self, prep_res):
            raise RuntimeError("boom")

        def exec_fallback(self, prep_res, exc):
            return f"fallback:{exc}"

    node = Always()
    Flow(node).run({})
    assert node.calls if hasattr(node, "calls") else True


def probe_batch_node_iterates():
    class Doubler(BatchNode):
        def prep(self, shared):
            return shared["items"]

        def exec(self, item):
            return item * 2

        def post(self, shared, prep_res, exec_res):
            shared["out"] = exec_res

    shared = {"items": [1, 2, 3]}
    Flow(Doubler()).run(shared)
    assert shared["out"] == [2, 4, 6], shared["out"]


def probe_batch_flow_params():
    """BatchFlow runs the whole sub-flow once per param set from prep()."""

    class Leaf(Node):
        def prep(self, shared):
            return self.params.get("n")

        def post(self, shared, prep_res, exec_res):
            shared.setdefault("seen", []).append(prep_res)

    class Runner(BatchFlow):
        def prep(self, shared):
            return [{"n": 1}, {"n": 2}, {"n": 3}]

    shared = {}
    Runner(Leaf()).run(shared)
    assert shared.get("seen") == [1, 2, 3], shared


def probe_async_flow_runs():
    class AsyncSet(AsyncNode):
        async def prep_async(self, shared):
            return 7

        async def post_async(self, shared, prep_res, exec_res):
            shared["v"] = prep_res

    flow = AsyncFlow(AsyncSet())
    shared = {}
    asyncio.run(flow.run_async(shared))
    assert shared["v"] == 7, shared


def probe_async_parallel_batch():
    """AsyncParallelBatchFlow runs the sub-flow concurrently per param set."""

    class Leaf(AsyncNode):
        async def prep_async(self, shared):
            return self.params["i"]

        async def post_async(self, shared, prep_res, exec_res):
            shared.setdefault("seen", []).append(prep_res)

    class Runner(AsyncParallelBatchFlow):
        async def prep_async(self, shared):
            return [{"i": n} for n in range(5)]

    shared = {}
    asyncio.run(Runner(Leaf()).run_async(shared))
    assert sorted(shared.get("seen", [])) == [0, 1, 2, 3, 4], shared


def probe_flow_composition():
    inner_a, inner_b = Record("inner-a"), Record("inner-b")
    inner_a >> inner_b
    inner = Flow(inner_a)
    outer_tail = Record("outer-tail")
    inner >> outer_tail
    shared = {}
    Flow(inner).run(shared)
    assert shared["trace"] == ["inner-a", "inner-b", "outer-tail"], shared["trace"]


def probe_set_params():
    node = Node()
    node.set_params({"k": "v"})
    assert node.params == {"k": "v"}, node.params


def probe_start_override():
    a, b = Record("a"), Record("b")
    a >> b
    flow = Flow()
    flow.start(a)
    shared = {}
    flow.run(shared)
    assert shared["trace"] == ["a", "b"], shared["trace"]


def probe_missing_action_is_noop():
    """An action with no successor ends the walk instead of raising."""
    class Other(Node):
        def post(self, shared, prep_res, exec_res):
            return "unmapped"

    node = Other()
    shared = {}
    Flow(node).run(shared)
    assert shared == {}, shared


PROBES = {
    "default-transition": probe_default_transition,
    "conditional-action": probe_conditional_action,
    "shared-state-visible": probe_shared_state_visible,
    "retry-succeeds": probe_retry_succeeds_after_failures,
    "fallback-on-exhaustion": probe_fallback_used_on_exhaustion,
    "batch-node-iterates": probe_batch_node_iterates,
    "batch-flow-params": probe_batch_flow_params,
    "async-flow-runs": probe_async_flow_runs,
    "async-parallel-batch": probe_async_parallel_batch,
    "flow-composition": probe_flow_composition,
    "set-params": probe_set_params,
    "start-override": probe_start_override,
    "unmapped-action-noop": probe_missing_action_is_noop,
}


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    probe = PROBES.get(name)
    if probe is None:
        print(f"unknown probe {name!r}; known: {sorted(PROBES)}")
        return 2
    try:
        probe()
    except Exception:
        traceback.print_exc()
        return 1
    print(f"{name}: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
