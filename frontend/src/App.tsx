import { RunPanel } from "./components/RunPanel";
import { InterruptCard } from "./components/InterruptCard";
import { HistoryPanel } from "./components/HistoryPanel";
import { ConversationsPanel } from "./components/ConversationsPanel";
import { useGraphThread } from "./lib/useGraphThread";
import "./App.css";

function App() {
  const {
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
    loadConversation,
    saveConversationTitle,
    startNewConversation,
    continueConversation,
  } = useGraphThread();

  return (
    <div className="app">
      <header>
        <h1>LangGraph Time-Travel Lab</h1>
        <p className="subtitle">
          No LLM involved — every node just appends a message. Use this to explore checkpoints,
          replay, forking, and human-in-the-loop interrupts.
        </p>
      </header>

      {error && <p className="error">{error}</p>}

      <main>
        <ConversationsPanel
          conversations={conversations}
          activeThreadId={threadId}
          isStreaming={isStreaming}
          onNew={startNewConversation}
          onSelect={loadConversation}
        />

        <RunPanel
          threadId={threadId}
          threadTitle={threadTitle}
          messages={liveState.messages}
          isStreaming={isStreaming}
          hasPendingInterrupt={!!pendingInterrupt}
          messageActions={messageActions}
          onStart={startThread}
          onContinue={continueConversation}
          onSaveTitle={saveConversationTitle}
          onReplayMessage={replayMessage}
          onEditMessage={editMessage}
        />

        {pendingInterrupt && (
          <InterruptCard
            interrupt={pendingInterrupt}
            isStreaming={isStreaming}
            onSubmit={submitInterruptResponse}
          />
        )}

        <details className="history-details">
          <summary>Branch history (all checkpoints, all branches)</summary>
          <HistoryPanel
            history={history}
            isStreaming={isStreaming}
            selectedCheckpointId={selectedCheckpointId}
            onSelect={setSelectedCheckpointId}
            onReplay={replayCheckpoint}
            onEditAndFork={editAndForkMessage}
            onResumeInterrupt={resumeAtInterruptCheckpoint}
          />
        </details>
      </main>
    </div>
  );
}

export default App;
