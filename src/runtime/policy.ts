import type { RuntimeMessage } from "./types.ts";

const retrievalPatterns = /(what did|what do|which|when did|why did|remember|recall|decide|decision|history|previous|last week|last time|preference|prefer|status|auth|authentication|oauth|workflow|project)/i;

export function latestUserMessage(messages: RuntimeMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? null;
}

export function shouldBootstrapRuntime(messages: RuntimeMessage[]) {
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  return assistantMessages.length === 0;
}

export function shouldRetrieveMemory({
  messages,
  latestUser,
}: {
  messages: RuntimeMessage[];
  latestUser: string | null;
}) {
  if (!latestUser) return false;
  if (shouldBootstrapRuntime(messages)) return latestUser.length >= 20;
  return retrievalPatterns.test(latestUser) || latestUser.includes("?");
}

export function buildRetrievalQuery(latestUser: string | null) {
  return latestUser?.trim() || null;
}
