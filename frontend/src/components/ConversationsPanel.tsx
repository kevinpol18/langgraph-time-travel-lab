import type { Thread } from "@langchain/langgraph-sdk";
import type { GraphState } from "../lib/types";

interface ConversationsPanelProps {
  conversations: Thread<GraphState>[];
  activeThreadId: string | null;
  isStreaming: boolean;
  onNew: () => void;
  onSelect: (threadId: string) => void;
}

function snippet(thread: Thread<GraphState>): string {
  const messages = thread.values?.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return "(empty)";
  const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  return content.length > 50 ? `${content.slice(0, 50)}…` : content;
}

export function ConversationsPanel({
  conversations,
  activeThreadId,
  isStreaming,
  onNew,
  onSelect,
}: ConversationsPanelProps) {
  return (
    <section className="panel">
      <div className="conversations-header">
        <h2>Conversations</h2>
        <button type="button" disabled={isStreaming} onClick={onNew}>
          + New conversation
        </button>
      </div>
      {conversations.length === 0 ? (
        <p className="checkpoint-note">No saved conversations yet -- start one above.</p>
      ) : (
        <ul className="conversation-list">
          {conversations.map((t) => (
            <li key={t.thread_id}>
              <button
                type="button"
                className={t.thread_id === activeThreadId ? "conversation-item active" : "conversation-item"}
                disabled={isStreaming}
                onClick={() => onSelect(t.thread_id)}
              >
                <span className="conversation-title">
                  {(t.metadata?.title as string | undefined) ?? t.thread_id}
                </span>
                <span className={`badge status-${t.status}`}>{t.status}</span>
                <span className="conversation-snippet">{snippet(t)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
