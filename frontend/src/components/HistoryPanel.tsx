import type { GraphThreadState } from "../lib/types";
import { CheckpointActions } from "./CheckpointActions";

interface HistoryPanelProps {
  history: GraphThreadState[];
  isStreaming: boolean;
  selectedCheckpointId: string | null;
  onSelect: (checkpointId: string) => void;
  onReplay: (checkpointId: string) => void;
  onEditAndFork: (checkpointId: string, message: { id?: string; type: string }, newContent: string) => void;
  onResumeInterrupt: (checkpointId: string, answer: string) => void;
}

function summarize(state: GraphThreadState): string {
  const messages = state.values.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return "(no messages yet)";
  const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  return content.length > 60 ? `${content.slice(0, 60)}…` : content;
}

export function HistoryPanel({
  history,
  isStreaming,
  selectedCheckpointId,
  onSelect,
  onReplay,
  onEditAndFork,
  onResumeInterrupt,
}: HistoryPanelProps) {
  if (history.length === 0) {
    return (
      <section className="panel">
        <h2>Thread history</h2>
        <p className="checkpoint-note">No checkpoints yet — start a thread first.</p>
      </section>
    );
  }

  const head = history[0]?.checkpoint.checkpoint_id;

  return (
    <section className="panel">
      <h2>Thread history</h2>
      <p className="checkpoint-note">
        Newest first. Select a checkpoint to replay it unchanged, or edit &amp; fork it into a
        new branch.
      </p>
      <ul className="history-list">
        {history.map((state) => {
          const checkpointId = state.checkpoint.checkpoint_id!;
          const isSelected = selectedCheckpointId === checkpointId;
          const isInterrupt = state.tasks.some((t) => t.interrupts && t.interrupts.length > 0);
          return (
            <li key={checkpointId} className={isSelected ? "history-item selected" : "history-item"}>
              <button type="button" className="history-item-header" onClick={() => onSelect(checkpointId)}>
                <code>{checkpointId.slice(0, 8)}</code>
                {checkpointId === head && <span className="badge">head</span>}
                {isInterrupt && <span className="badge badge-interrupt">interrupt</span>}
                <span className="history-next">next: {state.next.join(", ") || "(done)"}</span>
                <span className="history-summary">{summarize(state)}</span>
              </button>
              {isSelected && (
                <CheckpointActions
                  state={state}
                  isStreaming={isStreaming}
                  onReplay={onReplay}
                  onEditAndFork={onEditAndFork}
                  onResumeInterrupt={onResumeInterrupt}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
