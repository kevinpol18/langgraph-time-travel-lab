import { useEffect, useState } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import type { MessageAction } from "../lib/useGraphThread";

function messageText(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

interface RunPanelProps {
  threadId: string | null;
  threadTitle: string;
  messages: Message[];
  isStreaming: boolean;
  hasPendingInterrupt: boolean;
  messageActions: Map<string, MessageAction>;
  onStart: (input: string) => void;
  onContinue: (input: string) => void;
  onSaveTitle: (title: string) => void;
  onReplayMessage: (message: Message) => void;
  onEditMessage: (message: Message, newContent: string) => void;
}

export function RunPanel({
  threadId,
  threadTitle,
  messages,
  isStreaming,
  hasPendingInterrupt,
  messageActions,
  onStart,
  onContinue,
  onSaveTitle,
  onReplayMessage,
  onEditMessage,
}: RunPanelProps) {
  const [input, setInput] = useState("Please process this request");
  const [continueInput, setContinueInput] = useState("");
  const [titleInput, setTitleInput] = useState(threadTitle);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  useEffect(() => setTitleInput(threadTitle), [threadTitle]);

  const startEdit = (m: Message) => {
    setEditingId(m.id ?? null);
    setEditText(messageText(m));
  };

  const submitEdit = (m: Message) => {
    if (!editText.trim()) return;
    onEditMessage(m, editText.trim());
    setEditingId(null);
  };

  return (
    <section className="panel">
      <h2>Run</h2>
      {!threadId ? (
        <form
          className="run-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) onStart(input.trim());
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Initial message"
          />
          <button type="submit" disabled={isStreaming}>
            Start new thread
          </button>
        </form>
      ) : (
        <div className="thread-header">
          <code className="thread-id">{threadId}</code>
          <form
            className="title-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (titleInput.trim()) onSaveTitle(titleInput.trim());
            }}
          >
            <input
              value={titleInput}
              placeholder="Conversation title"
              onChange={(e) => setTitleInput(e.target.value)}
            />
            <button type="submit" disabled={isStreaming || titleInput.trim() === threadTitle}>
              Save title
            </button>
          </form>
        </div>
      )}

      <ol className="message-list">
        {messages.map((m, i) => {
          const action = m.id ? messageActions.get(m.id) : undefined;
          const isEditing = editingId !== null && editingId === m.id;
          return (
            <li key={m.id ?? i} className={`message message-${m.type}`}>
              <span className="message-type">{m.type}</span>
              {isEditing ? (
                <span className="message-edit-row">
                  <input
                    value={editText}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitEdit(m);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button type="button" disabled={isStreaming} onClick={() => submitEdit(m)}>
                    Save &amp; fork
                  </button>
                  <button type="button" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <span className="message-content">{messageText(m)}</span>
                  {m.type === "human" && action && (
                    <span className="message-icons">
                      <button
                        type="button"
                        className="icon-button"
                        title={action.isInterruptAnswer ? "Replay original answer" : "Replay unchanged"}
                        disabled={isStreaming}
                        onClick={() => onReplayMessage(m)}
                      >
                        ↻
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title={action.isInterruptAnswer ? "Edit answer & fork" : "Edit message & fork"}
                        disabled={isStreaming}
                        onClick={() => startEdit(m)}
                      >
                        ✎
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {isStreaming && <p className="status">streaming…</p>}

      {threadId && !isStreaming && !hasPendingInterrupt && (
        <form
          className="run-form continue-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (continueInput.trim()) {
              onContinue(continueInput.trim());
              setContinueInput("");
            }
          }}
        >
          <input
            value={continueInput}
            onChange={(e) => setContinueInput(e.target.value)}
            placeholder="Continue this conversation…"
          />
          <button type="submit">Send</button>
        </form>
      )}
    </section>
  );
}
