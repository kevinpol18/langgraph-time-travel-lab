# How Time Travel Works in This Project

This document explains, mechanically, how checkpoint replay, message editing/forking, and
human-in-the-loop (HITL) interrupt time travel actually work in this app — what LangGraph
gives you for free, what the LangGraph API server does under the hood, and the specific SDK
calls (and gotchas) required to drive it correctly. "Backend" here means the LangGraph
server's persistence model (checkpoints, threads, tasks) — the actual orchestration logic
lives in the client (`frontend/src/lib/useGraphThread.ts`), since `langgraph dev` exposes
time travel as an API, not a built-in UI feature.

Everything below was verified against a running `langgraph dev` server, via raw REST calls,
the JS SDK, the Python `RemoteGraph` client, and Playwright driving the actual browser UI.

## 1. The graph

`backend/graph/graph.py` — five pure functions, no LLM anywhere:

```
START → intake → collect_data → human_review → process_decision → finalize → END
```

State is one `TypedDict`:

```python
class State(TypedDict):
    messages: Annotated[list, add_messages]   # reducer, matters a lot (see §3)
    visited: Annotated[list[str], operator.add]
```

Every node except `human_review` just appends one message and returns. `human_review` is
the only interesting one:

```python
def human_review(state: State) -> dict:
    last = state["messages"][-1].content
    answer = interrupt({
        "question": "Please review the collected data and respond (e.g. 'approve' or 'reject: reason').",
        "context": last,
    })
    return {"messages": [HumanMessage(content=str(answer))], "visited": ["human_review"]}
```

`interrupt(payload)` raises internally, which the LangGraph runtime catches: it saves a
checkpoint, records the interrupt payload on that checkpoint's task list, and returns control
to the client without running `process_decision`/`finalize`. When later resumed with
`Command(resume=value)`, the runtime **re-executes `human_review` from the top** — everything
before the `interrupt()` call runs again — but this time `interrupt()` returns `value`
instead of raising, and the function continues normally.

No checkpointer is configured in `graph.py`. `langgraph dev` injects its own (SQLite-backed,
in `.langgraph_api/`) automatically.

## 2. What a checkpoint actually is

Every checkpoint (`ThreadState` in the SDK) has:

```ts
interface ThreadState<Values> {
  values: Values;                    // full accumulated state at this point
  next: string[];                    // node(s) about to run; [] means finished
  checkpoint: Checkpoint;            // { checkpoint_id, checkpoint_ns, thread_id }
  parent_checkpoint: Checkpoint | null;
  tasks: ThreadTask[];               // one entry per node in `next`
}

interface ThreadTask {
  name: string;
  interrupts: Interrupt[];           // non-empty iff this task hit interrupt()
  result?: unknown;                  // what the task returned, once it has run
}
```

**Key fact this whole project hinges on:** a checkpoint is captured *between* supersteps.
The checkpoint with `next: ["human_review"]` is simultaneously:

- "the state right after `collect_data` finished", **and**
- "the point where `human_review` is about to run" — which is exactly where a pause happens.

These are not two different checkpoints. There is only one, and once `human_review` has been
attempted from it at least once, its `tasks[0].interrupts` permanently records that interrupt
payload — even after the thread has long since moved past it. This is why editing the
`collect_data` message and editing the HITL answer both start from the *same* checkpoint in
history, and why the UI shows both action groups on that one checkpoint card.

Fetch this whole picture with `client.threads.getHistory(threadId, { limit: 50 })` — it
returns every checkpoint **across every branch**, newest-first.

## 3. Why `add_messages` makes editing possible at all

`messages: Annotated[list, add_messages]` isn't just "append to a list". `add_messages`
upserts by message `id`: if you write a message whose `id` matches one already in the list,
it **replaces that message in place** instead of appending a duplicate. That's the entire
mechanism behind "edit a message" — there's no special edit API, just:

```ts
client.threads.updateState(threadId, {
  values: { messages: [{ id: existingMessage.id, type: existingMessage.type, content: newText }] },
  checkpointId: targetCheckpointId,
});
```

`updateState` **never mutates** the target checkpoint — it always writes a **new** checkpoint,
as a child of the one you pointed at. The old checkpoint and everything that was built on it
remains in history, untouched. This is the fork.

## 4. Time travel on regular (non-interrupt) messages

Two operations, both starting from a checkpoint where a given message is the *last* entry in
`values.messages` (i.e., the checkpoint captured right after that message was written):

**Replay unchanged:**
```ts
client.runs.stream(threadId, "agent", { input: null, checkpoint: { checkpoint_id, checkpoint_ns: "" } })
```
`input: null` means "don't add new input, just continue". Pointing `checkpoint` at an old
checkpoint makes the run resume from *that* checkpoint's `next` forward, using its exact
state — re-executing every downstream node. Since it's not the current head, this produces a
brand new chain of checkpoints (a fork) even though nothing was edited.

**Edit & fork:**
```ts
const { configurable } = await client.threads.updateState(threadId, {
  values: { messages: [{ id, type, content: newText }] },
  checkpointId: targetCheckpointId,
});
await client.runs.stream(threadId, "agent", {
  input: null,
  checkpoint: { checkpoint_id: configurable.checkpoint_id, checkpoint_ns: "" },
});
```
Same idea, but the state is patched first. Downstream nodes then run against the edited
value.

Either way, the **newest checkpoint on the thread automatically becomes the thread's head** —
`threads.getState(threadId)` and a fresh `getHistory` call both reflect the new branch
immediately. There's no separate "make this the source of truth" step; it falls out of
"newest checkpoint wins."

## 5. Time travel on interrupts — the hard part

This is where the obvious approach breaks, twice, in two different ways.

### 5.1 The approach that looks right but silently does nothing

By analogy with §4, you'd expect this to "go back and answer differently":

```ts
// DOES NOT WORK once the thread has moved past this checkpoint
client.runs.stream(threadId, "agent", {
  command: { resume: newAnswer },
  checkpoint: { checkpoint_id: interruptCheckpointId, checkpoint_ns: "" },
});
```

Verified directly against the server (bypassing the SDK, via raw REST) that this **silently
no-ops**: no error, just returns the thread's current (unrelated) head state unchanged. The
reason: `resume` is matched against the thread's *currently pending* task, not an arbitrary
historical one. If the interrupt was already resolved once, there is no pending task left for
`resume` to match, `checkpoint` or not.

### 5.2 The fix: two calls, not one

```ts
// Step A -- re-enter the node fresh from the old checkpoint, no resume value supplied.
// interrupt() has no matching resume value this time, so it raises again -- a genuinely
// NEW, live, currently-pending pause, forked off the old checkpoint.
await client.runs.stream(threadId, "agent", {
  input: null,
  checkpoint: { checkpoint_id: interruptCheckpointId, checkpoint_ns: "" },
});

// Step B -- resume THAT fresh pause normally. No checkpoint override needed: step A's
// pause is now the thread's live head, so plain `resume` matches it directly.
await client.runs.stream(threadId, "agent", { command: { resume: newAnswer } });
```

This is `resumeAtInterruptCheckpoint` in `useGraphThread.ts`. Step A re-executes
`human_review` from scratch (per the LangGraph interrupt contract: resuming always restarts
the node from its top), which calls `interrupt()` again with no resume value queued for it —
so it pauses again, fresh. That fresh pause is a real live pending task, so step B's `resume`
works exactly like answering a first-time interrupt.

### 5.3 The deeper gotcha: don't re-enter a re-entry

Editing the HITL answer once works fine with §5.2. Editing *that* edited answer again breaks
if you naively target "the checkpoint immediately before the message" — because that
checkpoint is no longer the original; it's the fresh-pause checkpoint that step A of the
*first* edit created.

```
root interrupt checkpoint X  (recorded interrupt from the very first run)
└── X_a  (step A of edit #1: fresh re-entry, ALSO records an interrupt)
    └── Y_a  ("disapprove" — resolved via edit #1's step B)
```

Editing "disapprove" back to "approve" by re-entering **X_a** (its immediate predecessor)
reproduces exactly the reported bug: step A correctly reports a fresh interrupt, but step B's
`resume` comes back with the *old* cached "disapprove" result — the new answer is silently
discarded. This was confirmed to be specific to re-entering a checkpoint that was itself
produced by a prior re-entry; re-entering the **original** checkpoint X repeatedly (verified
4 times in a row, alternating answers) always works correctly.

**Fix — always resolve to the true root, no matter how many edits deep you are:**

```ts
function hasRecordedInterrupt(s: GraphThreadState): boolean {
  return s.tasks.some((t) => t.interrupts && t.interrupts.length > 0);
}

// Walk back through any chain of prior re-entries until the parent is NOT also an
// interrupt checkpoint -- that's the one reached by ordinary forward execution, i.e. root.
function findRootInterruptIndex(chain: GraphThreadState[], idx: number): number {
  while (idx > 0 && hasRecordedInterrupt(chain[idx - 1])) {
    idx -= 1;
  }
  return idx;
}
```

`chain` here is the current branch's checkpoints in oldest→newest order (see §6). Both X and
X_a have `tasks[].interrupts` recorded (both were, at some point, paused at `human_review`) —
the distinguishing signal is whether a checkpoint's *parent* is **also** an interrupt
checkpoint. If it is, the checkpoint in question is itself a re-entry product, and you keep
walking back. `computeMessageActions` (§6) calls this for every HITL-answer message, so the
UI always targets X, never X_a/X_b/…, regardless of edit depth.

## 6. Mapping a chat message to the right checkpoint (branch-aware)

`getHistory` returns every checkpoint from every branch ever created on the thread, mixed
together, newest-first. To know "what is the chat window currently showing," you cannot just
index into that list — you have to reconstruct the *one* lineage that is actually the current
head, by walking `parent_checkpoint` links backward:

```ts
function buildCurrentChain(history: GraphThreadState[]): GraphThreadState[] {
  const byId = new Map(history.map((s) => [s.checkpoint.checkpoint_id, s]));
  const chain = [];
  let cur = history[0]; // newest checkpoint overall == current head
  while (cur) {
    chain.push(cur);
    cur = cur.parent_checkpoint ? byId.get(cur.parent_checkpoint.checkpoint_id) : undefined;
  }
  return chain.reverse(); // root -> head
}
```

Then, for each adjacent pair in that chain, if `values.messages` grew by one entry, that
newest entry was "born" at the later checkpoint. If the checkpoint *before* it has a recorded
interrupt, the message is a HITL answer, and its "act on this" checkpoint is the §5.3 root,
not its immediate predecessor:

```ts
function computeMessageActions(chain: GraphThreadState[]): Map<string, MessageAction> {
  const map = new Map();
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1], cur = chain[i];
    const prevCount = prev.values.messages?.length ?? 0;
    const curMessages = cur.values.messages ?? [];
    if (curMessages.length > prevCount) {
      const newMsg = curMessages[curMessages.length - 1];
      const isInterruptAnswer = hasRecordedInterrupt(prev);
      const precedingCheckpointId = isInterruptAnswer
        ? chain[findRootInterruptIndex(chain, i - 1)].checkpoint.checkpoint_id
        : prev.checkpoint.checkpoint_id;
      map.set(newMsg.id, {
        msgCheckpointId: cur.checkpoint.checkpoint_id,
        precedingCheckpointId,
        isInterruptAnswer,
      });
    }
  }
  return map;
}
```

The chat UI's replay (↻) and edit (✎) icons on each human message call `replayMessage` /
`editMessage`, which look up this map and dispatch to either §4's plain edit-fork or §5.2's
two-step interrupt re-entry, automatically, per message.

## 7. SDK-level gotchas (not LangGraph concepts — implementation traps)

These cost the most debugging time and are specific to the installed
`@langchain/langgraph-sdk` version:

- **`checkpointId` (camelCase shorthand) is silently dropped** on `runs.stream`/`runs.create`
  — it's typed (`RunsInvokePayload.checkpointId?: string`) but never serialized into the
  request body. Confirmed by intercepting `fetch` and inspecting the actual outgoing JSON.
  Only the nested object form is honored:
  ```ts
  { checkpoint: { checkpoint_id: "...", checkpoint_ns: "" } }
  ```
  `threads.updateState`'s `checkpointId` string param is unaffected (different code path,
  works as documented).
- **`checkpoint_map` must be *omitted*, not set to `null`.** The `Checkpoint` TS type marks
  it required-but-nullable, but the server 422s (`"null is not of type \"object\""`) if the
  key is present at all with a null value.
- **Python's `RemoteGraph` has the analogous issue, via a different mechanism**: it
  deliberately strips `checkpoint_id`/`checkpoint_ns`/`checkpoint_map` out of
  `config["configurable"]` before sending anything (`_CONF_DROPLIST` in
  `langgraph.pregel.remote`) — `config` there is for run-level settings (tags, metadata), not
  checkpoint targeting. The tutorial pattern `graph.invoke(None, fork_config)` therefore does
  **not** retarget the checkpoint for a remote graph. The actual mechanism: `checkpoint_id` is
  a genuinely separate keyword argument that `RemoteGraph.invoke`/`.stream()` forward via
  `**kwargs` straight through to the underlying `langgraph_sdk` client:
  ```python
  graph.invoke(None, config, checkpoint_id=old_checkpoint_id)
  ```

## 8. Detecting "is this conversation currently at an interrupt?"

No manual checkpoint inspection needed for this part — the SDK's `Thread` object carries it
directly:

```ts
interface Thread<Values> {
  status: "idle" | "busy" | "interrupted" | "error";
  interrupts: Record<string, Interrupt[]>;  // populated iff status === "interrupted"
  values: Values;                            // current state, ready to render immediately
  metadata: Record<string, unknown>;         // where the conversation "title" lives
}
```

`client.threads.get(threadId)` (loading a saved conversation) or `client.threads.search(...)`
(listing all of them) both return this directly. Loading a conversation is therefore just:

```ts
const thread = await client.threads.get(threadId);
setLiveState(thread.values);
if (thread.status === "interrupted") {
  const intr = Object.values(thread.interrupts).flat()[0];
  setPendingInterrupt(intr.value); // show the interrupt card immediately, no extra call
}
```

This was verified to survive a full page reload — status/interrupts are read fresh from the
server every time, not cached client state.

## 9. Cheat sheet

| Want to... | Call |
|---|---|
| Replay a checkpoint unchanged | `runs.stream(tid, aid, { input: null, checkpoint: {checkpoint_id, checkpoint_ns:""} })` |
| Edit a regular message & fork | `threads.updateState(tid, { values:{messages:[{id,type,content}]}, checkpointId })` → replay the returned checkpoint |
| Answer a *live* interrupt | `runs.stream(tid, aid, { command: { resume: value } })` |
| Re-answer an *old* interrupt with a new value | Two calls: `{input:null, checkpoint:{...root}}` then `{command:{resume:newValue}}` — **always target the root checkpoint**, never an intermediate re-entry |
| List every checkpoint/branch | `threads.getHistory(tid, { limit })` |
| Find the current branch's lineage | Walk `parent_checkpoint` from `history[0]` backward |
| List saved conversations | `threads.search({ sortBy: "updated_at", sortOrder: "desc" })` |
| Load one + know if it's paused | `threads.get(tid)` → check `.status === "interrupted"` and `.interrupts` |
| Rename / "save" a conversation | `threads.create({ metadata: {title} })` or `threads.update(tid, { metadata: {title} })` |
| Continue a loaded conversation | `runs.stream(tid, aid, { input: {messages:[...]} })` on the existing `thread_id` |
