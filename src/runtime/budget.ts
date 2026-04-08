import type { RuntimeBudget, RuntimeMessage } from "./types.ts";

export function estimateTokenCount(value: string) {
  return Math.ceil(value.length / 4);
}

export function determineRuntimeBudget({
  messages,
  maxPromptTokens = 4096,
}: {
  messages: RuntimeMessage[];
  maxPromptTokens?: number;
}) {
  const approxPromptTokens = messages.reduce((total, message) => total + estimateTokenCount(message.content), 0);
  const remainingPromptTokens = Math.max(512, maxPromptTokens - approxPromptTokens);
  const maxRules = remainingPromptTokens >= 2500 ? 8 : remainingPromptTokens >= 1600 ? 6 : 4;
  const maxMemories = remainingPromptTokens >= 2500 ? 5 : remainingPromptTokens >= 1600 ? 4 : 3;

  return {
    approxPromptTokens,
    remainingPromptTokens,
    maxRules,
    maxMemories,
  } satisfies RuntimeBudget;
}
