# LangGraph Time-Travel Lab

A hands-on sandbox for LangGraph's persistence, time-travel, and human-in-the-loop (HITL)
mechanics — **no LLM required**. Every node in the graph is a pure function that just
appends a message to state; the point of the project is to exercise checkpoint replay,
message editing/forking, and interrupt time travel against a real `langgraph dev` server.

See **[TIME_TRAVEL.md](TIME_TRAVEL.md)** for a full technical breakdown of how the time
travel and interrupt mechanics actually work under the hood.

## What's here

- **`backend/`** — a 5-node LangGraph graph (`intake → collect_data → human_review →
  process_decision → finalize`), served via `langgraph dev`. `human_review` is the only
  node that calls `interrupt()`. Also includes `remote_graph_demo.py`, a Python script
  exercising the same time-travel mechanics through `langgraph.pregel.remote.RemoteGraph`.
- **`frontend/`** — a Vite + React + TypeScript chat UI built on `@langchain/langgraph-sdk`'s
  `Client`. Each human message gets replay (↻) and edit (✎) icons; editing/replaying a
  HITL answer correctly re-triggers the interrupt rather than just patching data. Includes
  a conversations panel for saving/loading/continuing threads, and a branch-history panel
  for browsing every checkpoint across every fork.

## Quick start

**Backend** (Python 3.11+):
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\langgraph.exe dev --no-browser --no-reload
```
Serves the API at `http://localhost:2024`.

> `--no-reload` matters here: `langgraph dev`'s file watcher has no way to exclude its own
> `.langgraph_api/` persistence directory, which it writes to periodically — without
> `--no-reload` this creates a reload loop that can intermittently break in-flight requests.

**Frontend**:
```powershell
cd frontend
npm install
npm run dev
```
Serves the UI at `http://localhost:5173`.

Open the frontend, start a conversation, and when the "Awaiting human input" card appears,
respond with `approve` or `reject: <reason>`. Then explore the ↻/✎ icons on your messages,
or expand "Branch history" to browse every checkpoint directly.
