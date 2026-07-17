"""Exercises the same time-travel/HITL-fork mechanics as the React frontend,
but through langgraph's `RemoteGraph` -- a client that mirrors the local
compiled-graph API (invoke/stream/get_state_history/update_state, all keyed
by RunnableConfig) while actually talking to a running `langgraph dev` server.

Run with the backend venv:
    .venv\\Scripts\\python.exe remote_graph_demo.py
"""

import uuid

from langgraph.pregel.remote import RemoteGraph
from langgraph.types import Command

API_URL = "http://127.0.0.1:2024"
ASSISTANT_ID = "agent"


def last(values: dict) -> dict:
    return values["messages"][-1]


def main() -> None:
    graph = RemoteGraph(ASSISTANT_ID, url=API_URL)

    thread_id = str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    print("== 1. Invoke until the interrupt ==")
    values = graph.invoke({"messages": [{"type": "human", "content": "remote graph demo"}]}, config)
    interrupts = values.get("__interrupt__")
    assert interrupts, "expected the run to pause on interrupt"
    print("interrupt payload:", interrupts[0]["value"])
    assert last(values)["content"].startswith("Collected data")

    print("\n== 2. Resume with Command(resume='approve') ==")
    values = graph.invoke(Command(resume="approve"), config)
    assert last(values)["content"] == "Workflow complete. Thread finalized."
    print("run completed:", [m["content"] for m in values["messages"]])

    print("\n== 3. get_state_history: find the collect_data/interrupt checkpoint ==")
    history = list(graph.get_state_history(config))
    print(f"{len(history)} checkpoints")
    for snap in history:
        print(" -", snap.config["configurable"]["checkpoint_id"][:8], "next=", snap.next)
    collect_data_snapshot = next(
        s for s in history if s.next == ("human_review",) and last(s.values)["content"].startswith("Collected data")
    )
    interrupt_task = next(t for t in collect_data_snapshot.tasks if t.interrupts)
    original_answer = interrupt_task.result["messages"][0]["content"]
    print("found checkpoint with recorded interrupt; original answer was:", repr(original_answer))

    print("\n== 4. Edit & fork the collect_data message via update_state ==")
    target_msg = last(collect_data_snapshot.values)
    fork_config = graph.update_state(
        collect_data_snapshot.config,
        {"messages": [{"id": target_msg["id"], "type": target_msg["type"], "content": "Collected data: {status: 'REMOTEGRAPH_EDIT', records: 7}"}]},
    )
    assert fork_config["configurable"]["checkpoint_id"] != collect_data_snapshot.config["configurable"]["checkpoint_id"]
    # RemoteGraph strips checkpoint_id/checkpoint_ns out of config.configurable before
    # sending it (they're in its _CONF_DROPLIST -- config is for run-level settings like
    # tags/metadata, not checkpoint targeting). update_state's returned config happens to
    # work as *input* here only because we pass checkpoint_id explicitly below; relying on
    # `fork_config` alone would silently retarget nothing, same class of bug as the JS SDK.
    values = graph.invoke(None, config, checkpoint_id=fork_config["configurable"]["checkpoint_id"])
    interrupts = values.get("__interrupt__")
    assert interrupts and "REMOTEGRAPH_EDIT" in interrupts[0]["value"]["context"]
    print("re-paused with edited context:", interrupts[0]["value"]["context"])

    values = graph.invoke(Command(resume="reject: bad data via RemoteGraph"), config)
    assert last(values)["content"] == "Workflow complete. Thread finalized."
    print("edited-message branch completed:", [m["content"] for m in values["messages"]])

    print("\n== 5. Replay/edit the ORIGINAL interrupt checkpoint with a NEW answer (two-step) ==")
    original_checkpoint_id = collect_data_snapshot.config["configurable"]["checkpoint_id"]
    # Single-shot (checkpoint + Command.resume together) silently no-ops once the thread
    # has moved past that checkpoint -- same behavior observed via the JS SDK and raw REST.
    # Step A: re-enter human_review fresh from the old checkpoint (no input/command) --
    # this re-executes interrupt() and pauses again, now as a live, currently-pending
    # interrupt forked off that old checkpoint. checkpoint_id must be passed as an
    # explicit kwarg (forwarded via **kwargs to the underlying SDK call), NOT via
    # config.configurable, per the _CONF_DROPLIST finding above.
    values = graph.invoke(None, config, checkpoint_id=original_checkpoint_id)
    interrupts = values.get("__interrupt__")
    assert interrupts, "expected a fresh pause when re-entering the old checkpoint"
    assert "REMOTEGRAPH_EDIT" not in interrupts[0]["value"]["context"], "should be the ORIGINAL collect_data data, not the fork's"
    print("re-entered original checkpoint, fresh interrupt:", interrupts[0]["value"])

    # Step B: resume that fresh pause normally (uses the thread's current head -- no
    # checkpoint override needed, since step A just made this checkpoint the head).
    values = graph.invoke(Command(resume="reject: second opinion via RemoteGraph"), config)
    assert last(values)["content"] == "Workflow complete. Thread finalized."
    assert any(m["content"] == "reject: second opinion via RemoteGraph" for m in values["messages"])
    assert not any("REMOTEGRAPH_EDIT" in m["content"] for m in values["messages"] if isinstance(m.get("content"), str))
    print("new branch off the ORIGINAL checkpoint:", [m["content"] for m in values["messages"]])

    print("\n== 6. Replay the original checkpoint with the ORIGINAL answer again (pure replay) ==")
    graph.invoke(None, config, checkpoint_id=original_checkpoint_id)
    values = graph.invoke(Command(resume=original_answer), config)
    assert last(values)["content"] == "Workflow complete. Thread finalized.", "replay with original answer should reproduce the original outcome"
    print("replayed branch:", [m["content"] for m in values["messages"]])

    final_history = list(graph.get_state_history(config))
    print(f"\nTotal checkpoints across all branches: {len(final_history)}")
    print("\nALL CHECKS PASSED (via RemoteGraph)")


if __name__ == "__main__":
    main()
