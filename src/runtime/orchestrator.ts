import { buildBehavioralContext } from "../behavioral.ts";
import type { TempleDatabase } from "../db.ts";
import { searchEpisodes } from "../episodic.ts";
import { determineRuntimeBudget } from "./budget.ts";
import { buildRetrievalQuery, latestUserMessage, shouldBootstrapRuntime, shouldRetrieveMemory } from "./policy.ts";
import { writebackRuntimeTurn } from "./writeback.ts";
import type { RuntimeMessage, RuntimeTurnPlan } from "./types.ts";

export async function prepareRuntimeTurn({
  temple,
  project,
  messages,
  maxPromptTokens = 4096,
}: {
  temple: TempleDatabase;
  project?: string | null;
  messages: RuntimeMessage[];
  maxPromptTokens?: number;
}) {
  const budget = determineRuntimeBudget({ messages, maxPromptTokens });
  const latestUser = latestUserMessage(messages);
  const shouldBootstrap = shouldBootstrapRuntime(messages);
  const shouldRetrieve = shouldRetrieveMemory({ messages, latestUser });
  const retrievalQuery = shouldRetrieve ? buildRetrievalQuery(latestUser) : null;

  const behavioral = await buildBehavioralContext({ temple, project, maxRules: budget.maxRules });
  if (behavioral instanceof Error) return behavioral;

  const retrievedMemories = retrievalQuery
    ? await searchEpisodes({ temple, query: retrievalQuery, project, limit: budget.maxMemories })
    : [];
  if (retrievedMemories instanceof Error) return retrievedMemories;

  const systemMessages = [
    behavioral.markdown,
    retrievedMemories.length > 0
      ? [
          "## Retrieved Episodic Memory",
          ...retrievedMemories.map((memory) => `- ${memory.summary}${memory.source ? ` source=${memory.source}` : ""}`),
        ].join("\n")
      : "",
  ].filter(Boolean);

  return {
    project: project?.trim() || null,
    latestUserMessage: latestUser,
    shouldBootstrap,
    shouldRetrieve,
    retrievalQuery,
    budget,
    rules: behavioral.rules,
    retrievedMemories,
    systemMessages,
  } satisfies RuntimeTurnPlan;
}

export async function completeRuntimeTurn({
  temple,
  project,
  sessionId,
  messages,
  assistantMessage,
}: {
  temple: TempleDatabase;
  project?: string | null;
  sessionId?: string | null;
  messages: RuntimeMessage[];
  assistantMessage?: string | null;
}) {
  return writebackRuntimeTurn({
    temple,
    project,
    sessionId,
    userMessage: latestUserMessage(messages),
    assistantMessage,
  });
}
