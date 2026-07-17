"""A deliberately LLM-free LangGraph graph for exercising time travel and HITL.

Every node is a pure function that appends a message to state -- nothing here
calls a model. The graph exists purely to give the frontend something to
stream, checkpoint, replay, fork, and interrupt.

Streaming: nodes emit their message as a custom event via get_stream_writer()
instead of relying on stream_mode="values" (which resends the ENTIRE
accumulated state on every step). Interrupts are detected separately via
stream_mode="updates", which surfaces a clean, dedicated `__interrupt__`
event -- no manual bookkeeping needed for that part.
"""

import operator
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.config import get_stream_writer
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.types import interrupt


class State(TypedDict):
    messages: Annotated[list, add_messages]
    visited: Annotated[list[str], operator.add]


def _emit(node: str, message) -> None:
    get_stream_writer()({"node": node, "message": message})


def intake(state: State) -> dict:
    last = state["messages"][-1].content if state["messages"] else "(no input)"
    message = AIMessage(content=f"Request received: {last!r}")
    _emit("intake", message)
    return {"messages": [message], "visited": ["intake"]}


def collect_data(state: State) -> dict:
    message = AIMessage(
        content="Collected data: {status: 'ok', records: 3, source: 'mock-dataset'}"
    )
    _emit("collect_data", message)
    return {"messages": [message], "visited": ["collect_data"]}


def human_review(state: State) -> dict:
    last = state["messages"][-1].content
    answer = interrupt(
        {
            "question": "Please review the collected data and respond (e.g. 'approve' or 'reject: reason').",
            "context": last,
        }
    )
    message = HumanMessage(content=str(answer))
    _emit("human_review", message)
    return {"messages": [message], "visited": ["human_review"]}


def process_decision(state: State) -> dict:
    human_answer = state["messages"][-1].content.strip().lower()
    if human_answer.startswith("approve"):
        verdict = "Decision: APPROVED. Proceeding to finalize."
    elif human_answer.startswith("reject"):
        verdict = f"Decision: REJECTED. Reason noted: {human_answer}"
    else:
        verdict = f"Decision: UNRECOGNIZED response ({human_answer!r}); treating as rejected."
    message = AIMessage(content=verdict)
    _emit("process_decision", message)
    return {"messages": [message], "visited": ["process_decision"]}


def finalize(state: State) -> dict:
    message = AIMessage(content="Workflow complete. Thread finalized.")
    _emit("finalize", message)
    return {"messages": [message], "visited": ["finalize"]}


builder = StateGraph(State)
builder.add_node("intake", intake)
builder.add_node("collect_data", collect_data)
builder.add_node("human_review", human_review)
builder.add_node("process_decision", process_decision)
builder.add_node("finalize", finalize)

builder.add_edge(START, "intake")
builder.add_edge("intake", "collect_data")
builder.add_edge("collect_data", "human_review")
builder.add_edge("human_review", "process_decision")
builder.add_edge("process_decision", "finalize")
builder.add_edge("finalize", END)

graph = builder.compile()
