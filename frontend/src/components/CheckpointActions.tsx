import { useState } from "react";
import type { GraphThreadState } from "../lib/types";

interface CheckpointActionsProps {
  state: GraphThreadState;
  isStreaming: boolean;
  onReplay: (checkpointId: string) => void;
  onEditAndFork: (checkpointId: string, message: { id?: string; type: string }, newContent: string) => void;
  onResumeInterrupt: (checkpointId: string, answer: string) => void;
}

function MessageActions({
  checkpointId,
  lastMessage,
  isStreaming,
  onReplay,
  onEditAndFork,
}: {
  checkpointId: string;
  lastMessage: { id?: string; type: string; content: unknown };
  isStreaming: boolean;
  onReplay: (checkpointId: string) => void;
  onEditAndFork: (checkpointId: string, message: { id?: string; type: string }, newContent: string) => void;
}) {
  const [editedText, setEditedText] = useState(
    typeof lastMessage.content === "string" ? lastMessage.content : "",
  );

  return (
    <div className="action-group">
      <p className="checkpoint-note">
        Last message at this checkpoint ({lastMessage.type}):
      </p>
      <button type="button" disabled={isStreaming} onClick={() => onReplay(checkpointId)}>
        Replay unchanged
      </button>
      <div className="edit-row">
        <input value={editedText} onChange={(e) => setEditedText(e.target.value)} />
        <button
          type="button"
          disabled={isStreaming || !editedText.trim()}
          onClick={() =>
            onEditAndFork(
              checkpointId,
              { id: lastMessage.id, type: lastMessage.type },
              editedText.trim(),
            )
          }
        >
          Edit message &amp; fork
        </button>
      </div>
    </div>
  );
}

function InterruptActions({
  checkpointId,
  interruptTask,
  isStreaming,
  onResumeInterrupt,
}: {
  checkpointId: string;
  interruptTask: GraphThreadState["tasks"][number];
  isStreaming: boolean;
  onResumeInterrupt: (checkpointId: string, answer: string) => void;
}) {
  const [answerText, setAnswerText] = useState("");
  const interruptValue = interruptTask.interrupts[0]?.value as
    | { question?: string; context?: string }
    | undefined;
  const result = interruptTask.result as { messages?: Array<{ content?: unknown }> } | undefined;
  const originalAnswer =
    result?.messages?.[0]?.content && typeof result.messages[0].content === "string"
      ? result.messages[0].content
      : undefined;

  return (
    <div className="action-group">
      <p className="checkpoint-note">
        HITL pause at <strong>human_review</strong>: {interruptValue?.question}
      </p>
      {originalAnswer === undefined ? (
        <p className="checkpoint-note">Not yet resolved — respond via the panel above.</p>
      ) : (
        <>
          <button
            type="button"
            disabled={isStreaming}
            onClick={() => onResumeInterrupt(checkpointId, originalAnswer)}
          >
            Replay original answer ({originalAnswer})
          </button>
          <div className="edit-row">
            <input
              value={answerText}
              placeholder="edited answer"
              onChange={(e) => setAnswerText(e.target.value)}
            />
            <button
              type="button"
              disabled={isStreaming || !answerText.trim()}
              onClick={() => onResumeInterrupt(checkpointId, answerText.trim())}
            >
              Edit answer &amp; fork
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function CheckpointActions({
  state,
  isStreaming,
  onReplay,
  onEditAndFork,
  onResumeInterrupt,
}: CheckpointActionsProps) {
  const checkpointId = state.checkpoint.checkpoint_id!;
  const interruptTask = state.tasks.find((t) => t.interrupts && t.interrupts.length > 0);
  const messages = state.values.messages ?? [];
  const lastMessage = messages[messages.length - 1];

  if (state.next.length === 0) {
    return <p className="checkpoint-note">Final state of this branch — nothing to fork forward into.</p>;
  }

  if (!lastMessage && !interruptTask) {
    return <p className="checkpoint-note">Start of thread — nothing to fork forward from yet.</p>;
  }

  return (
    <div className="checkpoint-actions">
      {lastMessage && (
        <MessageActions
          checkpointId={checkpointId}
          lastMessage={lastMessage}
          isStreaming={isStreaming}
          onReplay={onReplay}
          onEditAndFork={onEditAndFork}
        />
      )}
      {interruptTask && (
        <InterruptActions
          checkpointId={checkpointId}
          interruptTask={interruptTask}
          isStreaming={isStreaming}
          onResumeInterrupt={onResumeInterrupt}
        />
      )}
    </div>
  );
}
