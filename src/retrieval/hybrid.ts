import { normalizeText, overlapRatio, tokenize } from "../text.ts";
import { scoreRecency } from "../utils.ts";
import { buildQuerySemanticIndex, cosineSimilarity } from "./semantic.ts";
import type { MemoryScoreBreakdown, StoredMemory } from "../types.ts";

export const retrievalModes = ["hybrid", "lexical"] as const;
export type RetrievalMode = (typeof retrievalModes)[number];

export type IndexedMemory = StoredMemory & {
  embedding: number[];
};

export type RankedMemory = {
  memory: IndexedMemory;
  scoreBreakdown: MemoryScoreBreakdown;
};

export function rankHybridMemories({
  memories,
  query,
  mode = "hybrid",
}: {
  memories: IndexedMemory[];
  query: string;
  mode?: RetrievalMode;
}) {
  const trimmedQuery = query.trim();
  const queryTokens = tokenize(trimmedQuery);
  const normalizedQuery = normalizeText(trimmedQuery);
  const semanticQuery = buildQuerySemanticIndex(trimmedQuery);

  return memories
    .map((memory) => ({
      memory,
      scoreBreakdown: scoreMemory({
        memory,
        queryTokens,
        normalizedQuery,
        querySemanticTerms: semanticQuery.semanticTerms,
        queryEmbedding: semanticQuery.embedding,
        mode,
      }),
    }))
    .filter((result) => result.scoreBreakdown.total > 0);
}

function scoreMemory({
  memory,
  queryTokens,
  normalizedQuery,
  querySemanticTerms,
  queryEmbedding,
  mode,
}: {
  memory: IndexedMemory;
  queryTokens: string[];
  normalizedQuery: string;
  querySemanticTerms: string[];
  queryEmbedding: number[];
  mode: RetrievalMode;
}) {
  const contentTokens = tokenize(memory.content);
  const summaryTokens = tokenize(memory.summary);
  const tagTokens = memory.tags.flatMap((tag) => tokenize(tag));
  const lexical =
    overlapRatio(queryTokens, memory.keywords) * 0.35 +
    overlapRatio(queryTokens, summaryTokens) * 0.2 +
    overlapRatio(queryTokens, contentTokens) * 0.15;
  const semantic =
    mode === "hybrid"
      ? cosineSimilarity(queryEmbedding, memory.embedding) * 0.2 +
        overlapRatio(querySemanticTerms, memory.semanticTerms) * 0.25
      : 0;
  const phrase = normalizeText(memory.content).includes(normalizedQuery) ? 0.12 : 0;
  const tag = overlapRatio(queryTokens, tagTokens) * 0.05;
  const recency = scoreRecency(memory.createdAt, 45) * 0.05;
  const salience = (memory.salience / 10) * 0.08;

  return {
    lexical,
    semantic,
    phrase,
    tag,
    recency,
    salience,
    rerank: 0,
    total: lexical + semantic + phrase + tag + recency + salience,
  } satisfies MemoryScoreBreakdown;
}
