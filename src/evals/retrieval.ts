import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";

import { FileReadError, JsonParsingError, ValidationError } from "../errors.ts";
import { summarizeContent, extractKeywords } from "../text.ts";
import { rankHybridMemories, type IndexedMemory } from "../retrieval/hybrid.ts";
import { rerankHybridMemories } from "../retrieval/rerank.ts";
import { buildSemanticIndex } from "../retrieval/semantic.ts";
import type { StoredMemory } from "../types.ts";
import type {
  RetrievalBenchmarkDataset,
  RetrievalBenchmarkReport,
  RetrievalModeReport,
  RetrievalQueryReport,
} from "./types.ts";

export function defaultRetrievalBenchmarkPath() {
  return path.resolve(import.meta.dir, "../../fixtures/evals/retrieval-benchmark.json");
}

export async function loadRetrievalBenchmarkDataset(datasetPath = defaultRetrievalBenchmarkPath()) {
  const fileText = await fs.readFile(datasetPath, "utf8").catch((cause) => new FileReadError({ path: datasetPath, cause }));
  if (fileText instanceof Error) return fileText;

  const parsed = errore.try({
    try: () => JSON.parse(fileText) as unknown,
    catch: (cause) => new JsonParsingError({ context: `retrieval-benchmark:${datasetPath}`, cause }),
  });
  if (parsed instanceof Error) return parsed;

  const validated = validateDataset(parsed);
  if (validated instanceof Error) return validated;
  return validated;
}

export async function runRetrievalBenchmark({
  datasetPath,
  topK = 5,
}: {
  datasetPath?: string;
  topK?: number;
} = {}) {
  const dataset = await loadRetrievalBenchmarkDataset(datasetPath);
  if (dataset instanceof Error) return dataset;

  const indexedMemories = dataset.memories.map(toIndexedMemory);
  const lexical = evaluateMode({ dataset, indexedMemories, topK, mode: "lexical" });
  const hybrid = evaluateMode({ dataset, indexedMemories, topK, mode: "hybrid" });

  return {
    datasetName: dataset.name,
    topK,
    queryCount: dataset.queries.length,
    lexical,
    hybrid,
    uplift: {
      recallAtK: roundMetric(hybrid.recallAtK - lexical.recallAtK),
      mrr: roundMetric(hybrid.mrr - lexical.mrr),
      ndcgAtK: roundMetric(hybrid.ndcgAtK - lexical.ndcgAtK),
    },
  } satisfies RetrievalBenchmarkReport;
}

function evaluateMode({
  dataset,
  indexedMemories,
  topK,
  mode,
}: {
  dataset: RetrievalBenchmarkDataset;
  indexedMemories: IndexedMemory[];
  topK: number;
  mode: "lexical" | "hybrid";
}) {
  const reports = dataset.queries.map((query) => evaluateQuery({ query, indexedMemories, topK, mode }));

  return {
    mode,
    recallAtK: roundMetric(reports.filter((report) => report.hit).length / reports.length),
    mrr: roundMetric(reports.reduce((total, report) => total + report.reciprocalRank, 0) / reports.length),
    ndcgAtK: roundMetric(reports.reduce((total, report) => total + report.ndcg, 0) / reports.length),
    reports,
  } satisfies RetrievalModeReport;
}

function evaluateQuery({
  query,
  indexedMemories,
  topK,
  mode,
}: {
  query: RetrievalBenchmarkDataset["queries"][number];
  indexedMemories: IndexedMemory[];
  topK: number;
  mode: "lexical" | "hybrid";
}) {
  const scopedMemories = query.project
    ? indexedMemories.filter((memory) => memory.project === query.project)
    : indexedMemories;
  const ranked = rankHybridMemories({ memories: scopedMemories, query: query.query, mode });
  const finalRanked = mode === "hybrid" ? rerankHybridMemories({ ranked, query: query.query, topK }) : ranked.sort(sortByTotal).slice(0, topK);
  const topMemoryIds = finalRanked.slice(0, topK).map((result) => result.memory.id);
  const expected = new Set(query.expectedMemoryIds);
  const firstRelevantRank = topMemoryIds.findIndex((memoryId) => expected.has(memoryId));
  const hit = firstRelevantRank !== -1;
  const reciprocalRank = hit ? 1 / (firstRelevantRank + 1) : 0;
  const dcg = computeDcg({ rankedIds: topMemoryIds, expected });
  const idealDcg = computeIdealDcg({ relevantCount: Math.min(expected.size, topK) });
  const ndcg = idealDcg === 0 ? 0 : dcg / idealDcg;

  return {
    queryId: query.id,
    query: query.query,
    expectedMemoryIds: query.expectedMemoryIds,
    topMemoryIds,
    hit,
    reciprocalRank: roundMetric(reciprocalRank),
    dcg: roundMetric(dcg),
    ndcg: roundMetric(ndcg),
  } satisfies RetrievalQueryReport;
}

function toIndexedMemory(memory: RetrievalBenchmarkDataset["memories"][number]) {
  const tags = [...new Set((memory.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const summary = summarizeContent(memory.content);
  const semanticIndex = buildSemanticIndex({ content: memory.content, summary, tags });

  return {
    id: memory.id,
    project: memory.project?.trim() || null,
    source: memory.source?.trim() || null,
    content: memory.content,
    summary,
    tags,
    keywords: extractKeywords({ content: memory.content, tags }),
    semanticTerms: semanticIndex.semanticTerms,
    status: "active",
    supersededByMemoryId: null,
    salience: memory.salience ?? 5,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastAccessedAt: null,
    accessCount: 0,
    embedding: semanticIndex.embedding,
  } satisfies IndexedMemory;
}

function validateDataset(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new ValidationError({ field: "dataset", reason: "must be an object" });
  }

  const dataset = value as Partial<RetrievalBenchmarkDataset>;
  if (typeof dataset.name !== "string" || typeof dataset.description !== "string") {
    return new ValidationError({ field: "dataset", reason: "must include name and description strings" });
  }
  if (!Array.isArray(dataset.memories) || !Array.isArray(dataset.queries)) {
    return new ValidationError({ field: "dataset", reason: "must include memories and queries arrays" });
  }

  return dataset as RetrievalBenchmarkDataset;
}

function computeDcg({ rankedIds, expected }: { rankedIds: string[]; expected: Set<string> }) {
  return rankedIds.reduce((total, memoryId, index) => {
    if (!expected.has(memoryId)) return total;
    return total + 1 / Math.log2(index + 2);
  }, 0);
}

function computeIdealDcg({ relevantCount }: { relevantCount: number }) {
  return Array.from({ length: relevantCount }, (_, index) => 1 / Math.log2(index + 2)).reduce(
    (total, value) => total + value,
    0,
  );
}

function roundMetric(value: number) {
  return Number(value.toFixed(4));
}

function sortByTotal(left: { scoreBreakdown: { total: number } }, right: { scoreBreakdown: { total: number } }) {
  return right.scoreBreakdown.total - left.scoreBreakdown.total;
}
