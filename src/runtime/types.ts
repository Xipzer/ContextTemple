import type { MemorySearchResult, StoredRule } from "../types.ts";

export type RuntimeMessageRole = "system" | "user" | "assistant" | "tool";

export type RuntimeMessage = {
  role: RuntimeMessageRole;
  content: string;
  name?: string | null;
};

export type RuntimeBudget = {
  approxPromptTokens: number;
  remainingPromptTokens: number;
  maxRules: number;
  maxMemories: number;
};

export type RuntimeTurnPlan = {
  project: string | null;
  latestUserMessage: string | null;
  shouldBootstrap: boolean;
  shouldRetrieve: boolean;
  retrievalQuery: string | null;
  budget: RuntimeBudget;
  rules: StoredRule[];
  retrievedMemories: MemorySearchResult[];
  systemMessages: string[];
};

export type RuntimeWritebackResult = {
  observationsAdded: string[];
  memoriesAdded: string[];
};
