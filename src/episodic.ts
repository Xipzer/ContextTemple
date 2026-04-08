import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import type { TempleDatabase } from "./db.ts";
import { embedText } from "./embeddings/provider.ts";
import { DatabaseQueryError, ValidationError } from "./errors.ts";
import { applyMemoryLifecycle } from "./lifecycle/conflicts.ts";
import { episodicMemories, retrievalEvents } from "./schema.ts";
import { extractKeywords, summarizeContent } from "./text.ts";
import { rankHybridMemories, type IndexedMemory } from "./retrieval/hybrid.ts";
import { rerankHybridMemories } from "./retrieval/rerank.ts";
import { clamp, parseJsonNumberArray, parseJsonStringArray, stringifyJson } from "./utils.ts";
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
    semanticTerms: parseJsonStringArray({ value: row.semanticTermsJson, context: `memory:${row.id}:semantic_terms` }),
    embeddingProvider: row.embeddingProvider,
    embeddingModel: row.embeddingModel,
    status: row.status,
    supersededByMemoryId: row.supersededByMemoryId,
    salience: row.salience,
    positiveFeedbackCount: row.positiveFeedbackCount,
    negativeFeedbackCount: row.negativeFeedbackCount,
    usefulnessScore: row.usefulnessScore,
    lastFeedbackAt: row.lastFeedbackAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
  };
}

function mapIndexedMemory(row: typeof episodicMemories.$inferSelect): IndexedMemory {
  const semanticTerms = parseJsonStringArray({ value: row.semanticTermsJson, context: `memory:${row.id}:semantic_terms` });
  const embedding = parseJsonNumberArray({ value: row.embeddingJson, context: `memory:${row.id}:embedding` });

  return {
    ...mapMemory(row),
    semanticTerms,
    embedding,
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
  const summary = summarizeContent(content);
  const embedded = await embedText({ text: `${summary}\n${content}`, tags });
  if (embedded instanceof Error) return embedded;
  const keywords = extractKeywords({ content, tags });
  const project = input.project?.trim() || null;
  const source = input.source?.trim() || null;

  const existingRows = await (source
    ? episodicMemoryQuery({ temple, project, source })
    : episodicMemoryQuery({ temple, project })).catch(
    (cause) => new DatabaseQueryError({ operation: "fetch existing episodic memories", cause }),
  );
  if (existingRows instanceof Error) return existingRows;

  const exactExisting = existingRows.find(
    (row) => row.status === "active" && row.source === source && normalizeEpisode(row.content) === normalizeEpisode(content),
  );
  if (exactExisting) return mapMemory(exactExisting);

  const tagsJson = stringifyJson({ value: tags, context: "episodic tags" });
  if (tagsJson instanceof Error) return tagsJson;
  const keywordsJson = stringifyJson({ value: keywords, context: "episodic keywords" });
  if (keywordsJson instanceof Error) return keywordsJson;
  const semanticTermsJson = stringifyJson({ value: embedded.semanticTerms, context: "episodic semantic terms" });
  if (semanticTermsJson instanceof Error) return semanticTermsJson;
  const embeddingJson = stringifyJson({ value: embedded.embedding, context: "episodic embedding" });
  if (embeddingJson instanceof Error) return embeddingJson;

  const now = new Date();
  const record = {
    id: randomUUID(),
    project,
    source,
    content,
    summary,
    tagsJson,
    keywordsJson,
    semanticTermsJson,
    embeddingJson,
    embeddingProvider: embedded.provider,
    embeddingModel: embedded.model,
    status: "active" as const,
    supersededByMemoryId: null,
    salience: clamp(input.salience ?? 5, 1, 10),
    positiveFeedbackCount: 0,
    negativeFeedbackCount: 0,
    usefulnessScore: 0.5,
    lastFeedbackAt: null,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    accessCount: 0,
  } satisfies typeof episodicMemories.$inferInsert;

  const insertResult = await temple.db.insert(episodicMemories).values(record).catch(
    (cause) => new DatabaseQueryError({ operation: "insert episodic memory", cause }),
  );
  if (insertResult instanceof Error) return insertResult;

  const lifecycle = await applyMemoryLifecycle({
    temple,
    insertedMemory: {
      ...mapIndexedMemory(record),
      embedding: embedded.embedding,
    },
    candidateMemories: existingRows.filter((row) => row.status === "active").map(mapIndexedMemory),
  });
  if (lifecycle instanceof Error) return lifecycle;

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

  const memories = await fetchIndexedMemories({ temple, project });
  if (memories instanceof Error) return memories;

  const queryEmbedding = await embedText({ text: trimmedQuery });
  if (queryEmbedding instanceof Error) return queryEmbedding;

  const ranked = rankHybridMemories({
    memories,
    query: trimmedQuery,
    queryIndex: { semanticTerms: queryEmbedding.semanticTerms, embedding: queryEmbedding.embedding },
  });
  const reranked = rerankHybridMemories({ ranked, query: trimmedQuery }).slice(0, limit);
  const results: MemorySearchResult[] = [];

  for (const result of reranked) {
    const retrievalId = randomUUID();
    const insertEventResult = await temple.db
      .insert(retrievalEvents)
      .values({
        id: retrievalId,
        query: trimmedQuery,
        memoryId: result.memory.id,
        score: result.scoreBreakdown.total,
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
      ...toPublicMemory(result.memory),
      accessCount: result.memory.accessCount + 1,
      lastAccessedAt: new Date(),
      score: Number(result.scoreBreakdown.total.toFixed(4)),
      retrievalId,
      scoreBreakdown: {
        ...result.scoreBreakdown,
        total: Number(result.scoreBreakdown.total.toFixed(4)),
      },
    });
  }

  return results;
}

function toPublicMemory(memory: IndexedMemory): StoredMemory {
  return {
    id: memory.id,
    project: memory.project,
    source: memory.source,
    content: memory.content,
    summary: memory.summary,
    tags: memory.tags,
    keywords: memory.keywords,
    semanticTerms: memory.semanticTerms,
    embeddingProvider: memory.embeddingProvider,
    embeddingModel: memory.embeddingModel,
    status: memory.status,
    supersededByMemoryId: memory.supersededByMemoryId,
    salience: memory.salience,
    positiveFeedbackCount: memory.positiveFeedbackCount,
    negativeFeedbackCount: memory.negativeFeedbackCount,
    usefulnessScore: memory.usefulnessScore,
    lastFeedbackAt: memory.lastFeedbackAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastAccessedAt: memory.lastAccessedAt,
    accessCount: memory.accessCount,
  };
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
  const positiveFeedbackCount = memoryRow.positiveFeedbackCount + (accepted ? 1 : 0);
  const negativeFeedbackCount = memoryRow.negativeFeedbackCount + (accepted ? 0 : 1);
  const totalFeedback = positiveFeedbackCount + negativeFeedbackCount;
  const usefulnessScore = totalFeedback === 0 ? 0.5 : positiveFeedbackCount / totalFeedback;
  const updateMemoryResult = await temple.db
    .update(episodicMemories)
    .set({
      salience: nextSalience,
      positiveFeedbackCount,
      negativeFeedbackCount,
      usefulnessScore,
      lastFeedbackAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(episodicMemories.id, memoryRow.id))
    .catch((cause) => new DatabaseQueryError({ operation: "update episodic salience", cause }));
  if (updateMemoryResult instanceof Error) return updateMemoryResult;

  return {
    retrievalId,
    accepted,
    salience: nextSalience,
    usefulnessScore,
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
    query?.trim() ? `- Retrieved because the active query was: ${query.trim()}` : "- Retrieved from the most salient recent memories.",
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

async function fetchIndexedMemories({
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

  return rows.filter((row) => row.status === "active").map(mapIndexedMemory);
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

  return rows.filter((row) => row.status === "active").map((row) => ({
    ...mapMemory(row),
    score: 0,
    retrievalId: "recent",
    scoreBreakdown: {
      lexical: 0,
      semantic: 0,
      phrase: 0,
      tag: 0,
      recency: 0,
      salience: 0,
      rerank: 0,
      total: 0,
    },
  }));
}

function episodicMemoryQuery({
  temple,
  project,
  source,
}: {
  temple: TempleDatabase;
  project: string | null;
  source?: string | null;
}) {
  if (project && source) {
    return temple.db.select().from(episodicMemories).where(eq(episodicMemories.project, project));
  }
  if (project) {
    return temple.db.select().from(episodicMemories).where(eq(episodicMemories.project, project));
  }
  return temple.db.select().from(episodicMemories);
}

function normalizeEpisode(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
