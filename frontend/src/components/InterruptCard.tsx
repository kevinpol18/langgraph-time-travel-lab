import { useState } from "react";
import type { PendingInterrupt } from "../lib/types";

interface InterruptCardProps {
  interrupt: PendingInterrupt;
  isStreaming: boolean;
  onSubmit: (answer: string) => void;
}

export function InterruptCard({ interrupt, isStreaming, onSubmit }: InterruptCardProps) {
  const [answer, setAnswer] = useState("approve");

  return (
    <section className="panel interrupt-card">
      <h2>Awaiting human input</h2>
      {interrupt.question && <p className="interrupt-question">{interrupt.question}</p>}
      {interrupt.context && <p className="interrupt-context">{interrupt.context}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) onSubmit(answer.trim());
        }}
      >
        <input value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <button type="submit" disabled={isStreaming}>
          Submit response
        </button>
      </form>
    </section>
  );
}
