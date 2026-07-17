import { Client } from "@langchain/langgraph-sdk";
import type { GraphState } from "./types";

export const API_URL = "http://127.0.0.1:2024";
export const ASSISTANT_ID = "agent";

export const client = new Client<GraphState>({ apiUrl: API_URL });
