import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import type { TempleDatabase } from "./db.ts";
import { DatabaseQueryError, ValidationError } from "./errors.ts";
import { episodicMemories, retrievalEvents } from "./schema.ts";
import { extractKeywords, normalizeText, overlapRatio, summarizeContent, tokenize } from "./text.ts";
import { clamp, parseJsonStringArray, scoreRecency, stringifyJson } from "./utils.ts";
import type { EpisodicContextSnapshot, MemoryInput, MemorySearchResult, StoredMemory } from "./types.ts";

function mapMemory(row: typeof episodicMemories.$inferSelect): StoredMemory {
  return {
    id: row.id,
    project: row.project,
    source: row.source,
    content: row.content,
    summary: row.summary,
    tags: parseJsonStringArray({ value: row.tagsJson, context: `memory:${row.id}:tags` }),
    keywords: parseJsonStringArray({ value: row.keywordsJson, context: `memory:${row.id}:keywords` }),
    salience: row.salience,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
  };
}

export async function rememberEpisode({
  temple,
  input,
}: {
  temple: TempleDatabase;
  input: MemoryInput;
}) {
  const content = input.content.trim();
  if (!content) {
    return new ValidationError({ field: "content", reason: "must not be empty" });
  }

  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const keywords = extractKeywords({ content, tags });
  const tagsJson = stringifyJson({ value: tags, context: "episodic tags" });
  if (tagsJson instanceof Error) return tagsJson;
  const keywordsJson = stringifyJson({ value: keywords, context: "episodic keywords" });
  if (keywordsJson instanceof Error) return keywordsJson;

  const now = new Date();
  const record = {
    id: randomUUID(),
    project: input.project?.trim() || null,
    source: input.source?.trim() || null,
    content,
    summary: summarizeContent(content),
    tagsJson,
    keywordsJson,
    salience: clamp(input.salience ?? 5, 1, 10),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    accessCount: 0,
  } satisfies typeof episodicMemories.$inferInsert;

  const insertResult = await temple.db.insert(episodicMemories).values(record).catch(
    (cause) => new DatabaseQueryError({ operation: "insert episodic memory", cause }),
  );
  if (insertResult instanceof Error) return insertResult;

  return mapMemory(record);
}

export async function searchEpisodes({
  temple,
  query,
  project,
  limit = 5,
}: {
  temple: TempleDatabase;
  query: string;
  project?: string | null;
  limit?: number;
}) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return new ValidationError({ field: "query", reason: "must not be empty" });
  }

  const memories = await fetchMemories({ temple, project });
  if (memories instanceof Error) return memories;

  const queryTokens = tokenize(trimmedQuery);
  const normalizedQuery = normalizeText(trimmedQuery);
  const scored = memories
    .map((memory) => ({
      memory,
      score: scoreMemory({ memory, queryTokens, normalizedQuery }),
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const results: MemorySearchResult[] = [];

  for (const result of scored) {
    const retrievalId = randomUUID();
    const insertEventResult = await temple.db
      .insert(retrievalEvents)
      .values({
        id: retrievalId,
        query: trimmedQuery,
        memoryId: result.memory.id,
        score: result.score,
        accepted: null,
        createdAt: new Date(),
      })
      .catch((cause) => new DatabaseQueryError({ operation: "insert retrieval event", cause }));
    if (insertEventResult instanceof Error) return insertEventResult;

    const accessResult = await temple.db
      .update(episodicMemories)
      .set({
        accessCount: result.memory.accessCount + 1,
        lastAccessedAt: new Date(),
      })
      .where(eq(episodicMemories.id, result.memory.id))
      .catch((cause) => new DatabaseQueryError({ operation: "update episodic access metadata", cause }));
    if (accessResult instanceof Error) return accessResult;

    results.push({
      ...result.memory,
      accessCount: result.memory.accessCount + 1,
      lastAccessedAt: new Date(),
      score: Number(result.score.toFixed(4)),
      retrievalId,
    });
  }

  return results;
}

export async function recordRetrievalFeedback({
  temple,
  retrievalId,
  accepted,
}: {
  temple: TempleDatabase;
  retrievalId: string;
  accepted: boolean;
}) {
  const eventRows = await temple.db
    .select()
    .from(retrievalEvents)
    .where(eq(retrievalEvents.id, retrievalId))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch retrieval event", cause }));
  if (eventRows instanceof Error) return eventRows;

  const [event] = eventRows;

  if (!event) {
    return new ValidationError({ field: "retrievalId", reason: "was not found" });
  }

  const memoryRows = await temple.db
    .select()
    .from(episodicMemories)
    .where(eq(episodicMemories.id, event.memoryId))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch episodic memory for feedback", cause }));
  if (memoryRows instanceof Error) return memoryRows;

  const [memoryRow] = memoryRows;

  if (!memoryRow) {
    return new ValidationError({ field: "retrievalId", reason: "points at a missing memory" });
  }

  const updateEventResult = await temple.db
    .update(retrievalEvents)
    .set({ accepted })
    .where(eq(retrievalEvents.id, retrievalId))
    .catch((cause) => new DatabaseQueryError({ operation: "update retrieval feedback", cause }));
  if (updateEventResult instanceof Error) return updateEventResult;

  const nextSalience = clamp(memoryRow.salience + (accepted ? 0.35 : -0.15), 1, 10);
  const updateMemoryResult = await temple.db
    .update(episodicMemories)
    .set({ salience: nextSalience, updatedAt: new Date() })
    .where(eq(episodicMemories.id, memoryRow.id))
    .catch((cause) => new DatabaseQueryError({ operation: "update episodic salience", cause }));
  if (updateMemoryResult instanceof Error) return updateMemoryResult;

  return {
    retrievalId,
    accepted,
    salience: nextSalience,
  };
}

export async function buildEpisodicContext({
  temple,
  query,
  project,
  limit = 4,
}: {
  temple: TempleDatabase;
  query?: string | null;
  project?: string | null;
  limit?: number;
}) {
  const memories = query?.trim()
    ? await searchEpisodes({ temple, query, project, limit })
    : await listRecentEpisodes({ temple, project, limit });
  if (memories instanceof Error) return memories;

  const lines = [
    "## Episodic Memory",
    query?.trim()
      ? `- Retrieved because the active query was: ${query.trim()}`
      : "- Retrieved from the most salient recent memories.",
  ];

  if (memories.length === 0) {
    lines.push("", "- No episodic memory stored yet.");
  }

  for (const memory of memories) {
    const location = memory.project ? `[${memory.project}] ` : "";
    const source = memory.source ? ` source=${memory.source}` : "";
    lines.push(`- ${location}${memory.summary}${source}`);
  }

  return {
    markdown: lines.join("\n"),
    memories,
  } satisfies EpisodicContextSnapshot;
}

async function fetchMemories({
  temple,
  project,
}: {
  temple: TempleDatabase;
  project?: string | null;
}) {
  const trimmedProject = project?.trim() || null;
  const rows = await (
    trimmedProject
      ? temple.db.select().from(episodicMemories).where(eq(episodicMemories.project, trimmedProject))
      : temple.db.select().from(episodicMemories)
  ).catch((cause) => new DatabaseQueryError({ operation: "fetch episodic memories", cause }));
  if (rows instanceof Error) return rows;

  return rows.map(mapMemory);
}

async function listRecentEpisodes({
  temple,
  project,
  limit,
}: {
  temple: TempleDatabase;
  project?: string | null;
  limit: number;
}) {
  const trimmedProject = project?.trim() || null;
  const rows = await (
    trimmedProject
      ? temple.db
          .select()
          .from(episodicMemories)
          .where(eq(episodicMemories.project, trimmedProject))
          .orderBy(desc(episodicMemories.salience), desc(episodicMemories.createdAt))
          .limit(limit)
      : temple.db
          .select()
          .from(episodicMemories)
          .orderBy(desc(episodicMemories.salience), desc(episodicMemories.createdAt))
          .limit(limit)
  ).catch((cause) => new DatabaseQueryError({ operation: "list recent episodic memories", cause }));
  if (rows instanceof Error) return rows;

  return rows.map((row) => ({
    ...mapMemory(row),
    score: 0,
    retrievalId: "recent",
  }));
}

function scoreMemory({
  memory,
  queryTokens,
  normalizedQuery,
}: {
  memory: StoredMemory;
  queryTokens: string[];
  normalizedQuery: string;
}) {
  const contentTokens = tokenize(memory.content);
  const summaryTokens = tokenize(memory.summary);
  const tagTokens = memory.tags.flatMap((tag) => tokenize(tag));
  const phraseBonus = normalizeText(memory.content).includes(normalizedQuery) ? 0.2 : 0;
  const keywordScore = overlapRatio(queryTokens, memory.keywords) * 0.45;
  const summaryScore = overlapRatio(queryTokens, summaryTokens) * 0.2;
  const contentScore = overlapRatio(queryTokens, contentTokens) * 0.15;
  const tagScore = overlapRatio(queryTokens, tagTokens) * 0.05;
  const recencyScore = scoreRecency(memory.createdAt, 45) * 0.05;
  const salienceScore = (memory.salience / 10) * 0.1;

  return keywordScore + summaryScore + contentScore + tagScore + recencyScore + salienceScore + phraseBonus;
}
