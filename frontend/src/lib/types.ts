import type { Message, ThreadState } from "@langchain/langgraph-sdk";

export interface GraphState {
  messages: Message[];
  visited: string[];
}

export interface PendingInterrupt {
  id?: string;
  question?: string;
  context?: string;
}

export type GraphThreadState = ThreadState<GraphState>;
