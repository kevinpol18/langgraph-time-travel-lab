import { useCallback, useEffect, useMemo, useState } from "react";
import type { Checkpoint, Command, Interrupt, Message, Thread } from "@langchain/langgraph-sdk";
import { ASSISTANT_ID, client } from "./client";
import type { GraphState, GraphThreadState, PendingInterrupt } from "./types";

function titleFromInput(inputText: string): string {
  return inputText.length > 60 ? `${inputText.slice(0, 60)}…` : inputText;
}

function firstInterrupt(thread: Thread<GraphState>): Interrupt | undefined {
  return Object.values(thread.interrupts).flat()[0];
}

export interface MessageAction {
  msgCheckpointId: string;
  precedingCheckpointId: string;
  isInterruptAnswer: boolean;
}

// `getHistory` returns every checkpoint across every branch, newest-first. To know what
// the CURRENT branch's chat log actually is, walk parent_checkpoint links back from the
// head (history[0]) to the root -- that's the one true lineage the chat window shows.
function buildCurrentChain(history: GraphThreadState[]): GraphThreadState[] {
  if (history.length === 0) return [];
  const byId: Map<string, GraphThreadState> = new Map();
  for (const s of history) {
    if (s.checkpoint.checkpoint_id) byId.set(s.checkpoint.checkpoint_id, s);
  }
  const chainNewestFirst: GraphThreadState[] = [];
  const seen = new Set<string>();
  let cur: GraphThreadState | undefined = history[0];
  while (cur) {
    const curId: string | undefined = cur.checkpoint.checkpoint_id ?? undefined;
    if (!curId || seen.has(curId)) break;
    seen.add(curId);
    chainNewestFirst.push(cur);
    const parentId: string | undefined = cur.parent_checkpoint?.checkpoint_id ?? undefined;
    cur = parentId !== undefined ? byId.get(parentId) : undefined;
  }
  return chainNewestFirst.reverse(); // oldest (root) -> newest (head)
}

function hasRecordedInterrupt(s: GraphThreadState): boolean {
  return s.tasks.some((t) => t.interrupts && t.interrupts.length > 0);
}

// Editing a HITL answer re-enters the interrupt checkpoint fresh (see
// resumeAtInterruptCheckpoint). But re-entering a checkpoint that was ITSELF produced by
// an earlier re-entry hits a caching bug in the dev server: the new resume value is
// silently ignored and an old cached one gets reused instead. Re-entering the ORIGINAL
// checkpoint directly is reliable no matter how many times it's been edited before, so
// always walk back through any chain of prior re-entries to find that true root.
function findRootInterruptIndex(chain: GraphThreadState[], idx: number): number {
  while (idx > 0 && hasRecordedInterrupt(chain[idx - 1])) {
    idx -= 1;
  }
  return idx;
}

// For each message on the current branch, figure out which checkpoint to act on. A
// message is "born" at the checkpoint where it first appears as the newest entry; if the
// checkpoint immediately BEFORE that already has a recorded interrupt, this message is a
// HITL answer, and editing/replaying it must re-trigger that interrupt rather than just
// overwrite the message in place (see resumeAtInterruptCheckpoint).
function computeMessageActions(chain: GraphThreadState[]): Map<string, MessageAction> {
  const map = new Map<string, MessageAction>();
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const cur = chain[i];
    const prevCount = prev.values.messages?.length ?? 0;
    const curMessages = cur.values.messages ?? [];
    if (curMessages.length > prevCount) {
      const newMsg = curMessages[curMessages.length - 1];
      const msgCheckpointId = cur.checkpoint.checkpoint_id;
      const isInterruptAnswer = hasRecordedInterrupt(prev);
      const precedingCheckpointId = isInterruptAnswer
        ? chain[findRootInterruptIndex(chain, i - 1)].checkpoint.checkpoint_id
        : prev.checkpoint.checkpoint_id;
      if (newMsg?.id && msgCheckpointId && precedingCheckpointId) {
        map.set(newMsg.id, { msgCheckpointId, precedingCheckpointId, isInterruptAnswer });
      }
    }
  }
  return map;
}

interface RunOptions {
  input?: Record<string, unknown> | null;
  command?: Command;
  checkpointId?: string;
}

// The installed SDK version silently drops the `checkpointId` shorthand on
// run-level calls (runs.stream/create) -- only the nested `checkpoint` object
// is actually serialized into the request. `threads.updateState` doesn't have
// this issue, so it keeps using `checkpointId` directly. checkpoint_ns is
// always "" here since this graph has no subgraphs.
function toCheckpointRef(checkpointId?: string): Omit<Checkpoint, "thread_id"> | undefined {
  // checkpoint_map is typed as required-but-nullable, but the server 422s if the key
  // is present at all with a null value -- so it must be omitted, not set to null.
  return checkpointId
    ? ({ checkpoint_id: checkpointId, checkpoint_ns: "" } as Omit<Checkpoint, "thread_id">)
    : undefined;
}

const emptyState: GraphState = { messages: [], visited: [] };

function stateAtCheckpoint(history: GraphThreadState[], checkpointId: string): GraphState {
  const found = history.find((s) => s.checkpoint.checkpoint_id === checkpointId);
  return found ? { messages: found.values.messages ?? [], visited: found.values.visited ?? [] } : emptyState;
}

export function useGraphThread() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState<string>("");
  const [liveState, setLiveState] = useState<GraphState>(emptyState);
  const [pendingInterrupt, setPendingInterrupt] = useState<PendingInterrupt | null>(null);
  const [history, setHistory] = useState<GraphThreadState[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Thread<GraphState>[]>([]);

  const refreshHistory = useCallback(async (tid: string) => {
    const states = await client.threads.getHistory<GraphState>(tid, { limit: 50 });
    setHistory(states);
    return states;
  }, []);

  const refreshConversations = useCallback(async () => {
    const threads = await client.threads.search({ limit: 50, sortBy: "updated_at", sortOrder: "desc" });
    setConversations(threads);
  }, []);

  useEffect(() => {
    refreshConversations().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [refreshConversations]);

  // Streams a run using "custom" events -- each node emits exactly the one message it just
  // produced via get_stream_writer(), instead of resending the whole accumulated state
  // every step ("values" mode). "updates" is layered in purely for a clean, dedicated
  // __interrupt__ signal (native to the platform, no manual bookkeeping needed for that
  // part). Because custom events carry only a delta, the caller must supply `seed`: the
  // correct messages/visited to start accumulating from (e.g. the state at whichever
  // checkpoint this run is forking from -- NOT necessarily the current head). The final
  // state is always reconciled against the authoritative persisted checkpoint (via
  // getHistory) once the run ends: messages streamed over the custom channel don't have
  // their real id assigned yet -- that only happens when the reducer merges the node's
  // return value into the checkpoint, which happens after the custom event fires.
  const runAndStream = useCallback(
    async (tid: string, options: RunOptions, seed: GraphState): Promise<GraphState> => {
      setIsStreaming(true);
      setError(null);
      setPendingInterrupt(null);
      let messages = seed.messages;
      let visited = seed.visited;
      setLiveState({ messages, visited });
      try {
        const { checkpointId, ...rest } = options;
        const stream = client.runs.stream(tid, ASSISTANT_ID, {
          ...rest,
          checkpoint: toCheckpointRef(checkpointId),
          streamMode: ["custom", "updates"],
        });
        for await (const chunk of stream) {
          if (chunk.event === "custom") {
            const data = chunk.data as { node: string; message: Message };
            messages = [...messages, data.message];
            visited = [...visited, data.node];
            setLiveState({ messages, visited });
          } else if (chunk.event === "updates") {
            const data = chunk.data as Record<string, unknown> & {
              __interrupt__?: Array<{ id?: string; value?: Record<string, unknown> }>;
            };
            if (data.__interrupt__?.length) {
              const intr = data.__interrupt__[0];
              setPendingInterrupt({
                id: intr.id,
                question: intr.value?.question as string | undefined,
                context: intr.value?.context as string | undefined,
              });
            }
          } else if (chunk.event === "error") {
            const data = chunk.data as { message?: string; error?: string };
            setError(data.message ?? data.error ?? "Unknown stream error");
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsStreaming(false);
        const states = await refreshHistory(tid);
        await refreshConversations();
        if (states.length > 0) {
          const head = states[0].values;
          messages = head.messages ?? [];
          visited = head.visited ?? [];
          setLiveState({ messages, visited });
        }
      }
      return { messages, visited };
    },
    [refreshHistory, refreshConversations],
  );

  const startThread = useCallback(
    async (inputText: string) => {
      setError(null);
      setIsStreaming(true);
      try {
        const thread = await client.threads.create({ metadata: { title: titleFromInput(inputText) } });
        setThreadId(thread.thread_id);
        setThreadTitle(titleFromInput(inputText));
        setHistory([]);
        setSelectedCheckpointId(null);
        await runAndStream(
          thread.thread_id,
          { input: { messages: [{ type: "human", content: inputText }] } },
          { messages: [{ type: "human", content: inputText }], visited: [] },
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setIsStreaming(false);
      }
    },
    [runAndStream],
  );

  const continueConversation = useCallback(
    async (inputText: string) => {
      if (!threadId) return;
      const seed: GraphState = {
        messages: [...liveState.messages, { type: "human", content: inputText }],
        visited: liveState.visited,
      };
      await runAndStream(threadId, { input: { messages: [{ type: "human", content: inputText }] } }, seed);
    },
    [threadId, liveState, runAndStream],
  );

  const loadConversation = useCallback(
    async (tid: string) => {
      setError(null);
      try {
        const thread = await client.threads.get(tid);
        setThreadId(thread.thread_id);
        setThreadTitle((thread.metadata?.title as string | undefined) ?? thread.thread_id);
        setLiveState({ messages: thread.values?.messages ?? [], visited: thread.values?.visited ?? [] });
        setSelectedCheckpointId(null);
        if (thread.status === "interrupted") {
          const intr = firstInterrupt(thread);
          setPendingInterrupt({
            id: intr?.id,
            question: intr?.value ? (intr.value as { question?: string }).question : undefined,
            context: intr?.value ? (intr.value as { context?: string }).context : undefined,
          });
        } else {
          setPendingInterrupt(null);
        }
        await refreshHistory(tid);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshHistory],
  );

  const saveConversationTitle = useCallback(
    async (title: string) => {
      if (!threadId) return;
      await client.threads.update(threadId, { metadata: { title } });
      setThreadTitle(title);
      await refreshConversations();
    },
    [threadId, refreshConversations],
  );

  const startNewConversation = useCallback(() => {
    setThreadId(null);
    setThreadTitle("");
    setLiveState(emptyState);
    setHistory([]);
    setPendingInterrupt(null);
    setSelectedCheckpointId(null);
    setError(null);
  }, []);

  const submitInterruptResponse = useCallback(
    async (answer: string) => {
      if (!threadId) return;
      await runAndStream(threadId, { command: { resume: answer } }, liveState);
    },
    [threadId, liveState, runAndStream],
  );

  const replayCheckpoint = useCallback(
    async (checkpointId: string) => {
      if (!threadId) return;
      const seed = stateAtCheckpoint(history, checkpointId);
      await runAndStream(threadId, { input: null, checkpointId }, seed);
    },
    [threadId, history, runAndStream],
  );

  const editAndForkMessage = useCallback(
    async (checkpointId: string, message: { id?: string; type: string }, newContent: string) => {
      if (!threadId) return;
      setError(null);
      try {
        const newConfig = await client.threads.updateState(threadId, {
          values: { messages: [{ id: message.id, type: message.type, content: newContent }] },
          checkpointId,
        });
        const newCheckpointId = newConfig.configurable?.checkpoint_id as string;
        const base = stateAtCheckpoint(history, checkpointId);
        const seed: GraphState = {
          messages: base.messages.map((m) => (m.id === message.id ? { ...m, content: newContent } : m)),
          visited: base.visited,
        };
        await runAndStream(threadId, { input: null, checkpointId: newCheckpointId }, seed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [threadId, history, runAndStream],
  );

  const resumeAtInterruptCheckpoint = useCallback(
    async (checkpointId: string, answer: string) => {
      if (!threadId) return;
      // A single call combining checkpointId + command.resume silently no-ops once the
      // thread has moved past that checkpoint (the server only matches `resume` against
      // a *currently* pending interrupt). So this is two steps: first re-enter human_review
      // from the old checkpoint with no input, which re-executes interrupt() and pauses
      // fresh (this becomes the new branch's head); then resume that fresh pause normally.
      const seed = stateAtCheckpoint(history, checkpointId);
      const afterReentry = await runAndStream(threadId, { input: null, checkpointId }, seed);
      await runAndStream(threadId, { command: { resume: answer } }, afterReentry);
    },
    [threadId, history, runAndStream],
  );

  const chain = useMemo(() => buildCurrentChain(history), [history]);
  const messageActions = useMemo(() => computeMessageActions(chain), [chain]);

  // Chat-native entry points: given a message bubble in the chat window, replay it
  // unchanged or fork it with edited content -- routing to the interrupt re-trigger vs.
  // the plain message-edit path depending on what that message actually is.
  const replayMessage = useCallback(
    async (message: { id?: string; type: string; content: unknown }) => {
      if (!message.id) return;
      const action = messageActions.get(message.id);
      if (!action) return;
      if (action.isInterruptAnswer) {
        const original = typeof message.content === "string" ? message.content : String(message.content);
        await resumeAtInterruptCheckpoint(action.precedingCheckpointId, original);
      } else {
        await replayCheckpoint(action.msgCheckpointId);
      }
    },
    [messageActions, resumeAtInterruptCheckpoint, replayCheckpoint],
  );

  const editMessage = useCallback(
    async (message: { id?: string; type: string }, newContent: string) => {
      if (!message.id) return;
      const action = messageActions.get(message.id);
      if (!action) return;
      if (action.isInterruptAnswer) {
        await resumeAtInterruptCheckpoint(action.precedingCheckpointId, newContent);
      } else {
        await editAndForkMessage(action.msgCheckpointId, { id: message.id, type: message.type }, newContent);
      }
    },
    [messageActions, resumeAtInterruptCheckpoint, editAndForkMessage],
  );

  return {
    threadId,
    threadTitle,
    liveState,
    pendingInterrupt,
    history,
    isStreaming,
    error,
    selectedCheckpointId,
    setSelectedCheckpointId,
    startThread,
    submitInterruptResponse,
    replayCheckpoint,
    editAndForkMessage,
    resumeAtInterruptCheckpoint,
    messageActions,
    replayMessage,
    editMessage,
    conversations,
    refreshConversations,
    loadConversation,
    saveConversationTitle,
    startNewConversation,
    continueConversation,
  };
}
