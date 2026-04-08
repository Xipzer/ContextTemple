import { randomUUID } from "node:crypto";

import { asc, desc, eq } from "drizzle-orm";

import type { TempleDatabase } from "../db.ts";
import { clusterEmbeddingItems } from "../embeddings/cluster.ts";
import { embedTexts } from "../embeddings/provider.ts";
import { DatabaseQueryError, ValidationError } from "../errors.ts";
import { extractionRuns, extractedCandidates, transcriptSources } from "../schema.ts";
import { buildFingerprint, summarizeContent } from "../text.ts";
import { parseJsonStringArray, stringifyJson } from "../utils.ts";
import { listTranscriptEvents } from "../ingest/transcripts.ts";
import type { StoredTranscriptEvent } from "../ingest/types.ts";
import type { BehavioralDimension } from "../types.ts";
import type {
  ExtractionCandidateCluster,
  ExtractionCandidateDraft,
  ExtractionRun,
  ExtractionCandidateReviewStatus,
  StoredExtractionCandidate,
  TranscriptExtractionResult,
} from "./types.ts";

const extractionEngineVersion = "heuristic-v1";

export async function extractTranscriptCandidates({
  temple,
  transcriptId,
}: {
  temple: TempleDatabase;
  transcriptId: string;
}) {
  const transcriptRows = await temple.db
    .select()
    .from(transcriptSources)
    .where(eq(transcriptSources.id, transcriptId))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch transcript for extraction", cause }));
  if (transcriptRows instanceof Error) return transcriptRows;

  const transcript = transcriptRows[0];
  if (!transcript) {
    return new ValidationError({ field: "transcriptId", reason: "was not found" });
  }

  const existingRuns = await temple.db
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.transcriptId, transcriptId))
    .orderBy(desc(extractionRuns.createdAt))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch extraction runs", cause }));
  if (existingRuns instanceof Error) return existingRuns;

  const existingRun = existingRuns.find((run) => run.engineVersion === extractionEngineVersion);
  if (existingRun) {
    const candidates = await listExtractionCandidates({ temple, transcriptId, extractionRunId: existingRun.id });
    if (candidates instanceof Error) return candidates;

    return {
      duplicate: true,
      run: mapExtractionRun(existingRun),
      candidates,
    } satisfies TranscriptExtractionResult;
  }

  const events = await listTranscriptEvents({ temple, transcriptId });
  if (events instanceof Error) return events;

  const drafts = deriveCandidates({ events, project: transcript.project });
  const runId = randomUUID();
  const warnings: string[] = [];
  const warningsJson = stringifyJson({ value: warnings, context: `extraction_run:${runId}:warnings` });
  if (warningsJson instanceof Error) return warningsJson;

  const runRow = {
    id: runId,
    transcriptId,
    project: transcript.project,
    engineVersion: extractionEngineVersion,
    candidateCount: drafts.length,
    warningsJson,
    createdAt: new Date(),
  } satisfies typeof extractionRuns.$inferInsert;

  const insertRunResult = await temple.db.insert(extractionRuns).values(runRow).catch(
    (cause) => new DatabaseQueryError({ operation: "insert extraction run", cause }),
  );
  if (insertRunResult instanceof Error) return insertRunResult;

  const candidateRows: Array<typeof extractedCandidates.$inferInsert> = [];
  const storedCandidates: StoredExtractionCandidate[] = [];

  for (const draft of drafts) {
    const sourceEventIdsJson = stringifyJson({
      value: draft.sourceEventIds,
      context: `extracted_candidate:${runId}:source_event_ids`,
    });
    if (sourceEventIdsJson instanceof Error) return sourceEventIdsJson;

    const metadataJson = stringifyJson({
      value: draft.metadata,
      context: `extracted_candidate:${runId}:metadata`,
    });
    if (metadataJson instanceof Error) return metadataJson;

    const candidateId = randomUUID();
    const createdAt = new Date();

    candidateRows.push({
      id: candidateId,
      extractionRunId: runId,
      transcriptId,
      project: transcript.project,
      candidateType: draft.candidateType,
      behavioralDimension: draft.behavioralDimension,
      statement: draft.statement,
      evidence: draft.evidence,
      confidence: draft.confidence,
      sourceEventIdsJson,
    metadataJson,
    reviewStatus: "pending",
    reviewNote: null,
    reviewedAt: null,
    promotedAt: null,
    createdAt,
  });

  storedCandidates.push({
      id: candidateId,
      extractionRunId: runId,
      transcriptId,
      project: transcript.project,
      candidateType: draft.candidateType,
      behavioralDimension: draft.behavioralDimension,
      statement: draft.statement,
      evidence: draft.evidence,
      confidence: draft.confidence,
      sourceEventIds: draft.sourceEventIds,
      metadata: draft.metadata,
      reviewStatus: "pending",
      reviewNote: null,
      reviewedAt: null,
      promotedAt: null,
      createdAt,
    });
  }

  if (candidateRows.length > 0) {
    const insertCandidatesResult = await temple.db.insert(extractedCandidates).values(candidateRows).catch(
      (cause) => new DatabaseQueryError({ operation: "insert extracted candidates", cause }),
    );
    if (insertCandidatesResult instanceof Error) return insertCandidatesResult;
  }

  return {
    duplicate: false,
    run: mapExtractionRun(runRow),
    candidates: storedCandidates,
  } satisfies TranscriptExtractionResult;
}

export async function listExtractionRuns({
  temple,
  project,
  transcriptId,
  limit = 20,
}: {
  temple: TempleDatabase;
  project?: string | null;
  transcriptId?: string | null;
  limit?: number;
}) {
  const rows = await temple.db
    .select()
    .from(extractionRuns)
    .orderBy(desc(extractionRuns.createdAt))
    .limit(limit)
    .catch((cause) => new DatabaseQueryError({ operation: "list extraction runs", cause }));
  if (rows instanceof Error) return rows;

  return rows
    .filter((row) => (project?.trim() ? row.project === project.trim() : true))
    .filter((row) => (transcriptId?.trim() ? row.transcriptId === transcriptId.trim() : true))
    .map(mapExtractionRun);
}

export async function listExtractionCandidates({
  temple,
  transcriptId,
  extractionRunId,
  reviewStatus,
}: {
  temple: TempleDatabase;
  transcriptId?: string | null;
  extractionRunId?: string | null;
  reviewStatus?: ExtractionCandidateReviewStatus | null;
}) {
  const rows = await temple.db
    .select()
    .from(extractedCandidates)
    .orderBy(asc(extractedCandidates.createdAt))
    .catch((cause) => new DatabaseQueryError({ operation: "list extracted candidates", cause }));
  if (rows instanceof Error) return rows;

  return rows
    .filter((row) => (transcriptId?.trim() ? row.transcriptId === transcriptId.trim() : true))
    .filter((row) => (extractionRunId?.trim() ? row.extractionRunId === extractionRunId.trim() : true))
    .filter((row) => (reviewStatus ? row.reviewStatus === reviewStatus : true))
    .map(mapExtractionCandidate);
}

export async function reviewExtractionCandidate({
  temple,
  candidateId,
  status,
  note,
}: {
  temple: TempleDatabase;
  candidateId: string;
  status: ExtractedCandidateReviewMutation;
  note?: string | null;
}) {
  const rows = await temple.db.select().from(extractedCandidates).where(eq(extractedCandidates.id, candidateId)).catch(
    (cause) => new DatabaseQueryError({ operation: "fetch extraction candidate for review", cause }),
  );
  if (rows instanceof Error) return rows;

  const candidate = rows[0];
  if (!candidate) return new ValidationError({ field: "candidateId", reason: "was not found" });

  const reviewStatus = status === "approve" ? "approved" : status === "reject" ? "rejected" : "pending";
  const updateResult = await temple.db
    .update(extractedCandidates)
    .set({ reviewStatus, reviewNote: note?.trim() || null, reviewedAt: new Date() })
    .where(eq(extractedCandidates.id, candidateId))
    .catch((cause) => new DatabaseQueryError({ operation: "review extraction candidate", cause }));
  if (updateResult instanceof Error) return updateResult;

  return {
    candidateId,
    reviewStatus,
    reviewNote: note?.trim() || null,
  };
}

export async function clusterExtractionCandidates({
  temple,
  project,
  extractionRunId,
}: {
  temple: TempleDatabase;
  project?: string | null;
  extractionRunId?: string | null;
}) {
  const candidates = await listExtractionCandidates({ temple, extractionRunId, reviewStatus: "pending" });
  if (candidates instanceof Error) return candidates;

  const scopedCandidates = candidates.filter((candidate) => (project?.trim() ? candidate.project === project.trim() : true));
  if (scopedCandidates.length === 0) return [] satisfies ExtractionCandidateCluster[];

  const embeddings = await embedTexts({ texts: scopedCandidates.map((candidate) => candidate.statement) });
  if (embeddings instanceof Error) return embeddings;

  const clusters = clusterEmbeddingItems({
    items: scopedCandidates.map((candidate, index) => ({
      id: candidate.id,
      label: candidate.statement,
      embedding: embeddings[index]!.embedding,
      semanticTerms: embeddings[index]!.semanticTerms,
    })),
    threshold: 0.87,
  });

  return clusters.map((cluster) => ({
    id: cluster.id,
    project: project?.trim() || null,
    label: cluster.label,
    candidateIds: cluster.itemIds,
    similarity: cluster.similarity,
  } satisfies ExtractionCandidateCluster));
}

export type ExtractedCandidateReviewMutation = "approve" | "reject" | "reset";

function deriveCandidates({
  events,
  project,
}: {
  events: StoredTranscriptEvent[];
  project: string | null;
}) {
  const seenFingerprints = new Set<string>();
  const drafts: ExtractionCandidateDraft[] = [];

  for (const event of events) {
    if (event.actor === "user" && event.eventType === "message") {
      const observation = deriveObservationCandidate(event);
      if (observation) pushCandidate({ drafts, seenFingerprints, candidate: observation });

      const decision = deriveDecisionCandidate(event, project);
      if (decision) pushCandidate({ drafts, seenFingerprints, candidate: decision });

      const fact = deriveFactCandidate(event, project);
      if (fact) pushCandidate({ drafts, seenFingerprints, candidate: fact });
    }

    if (event.actor === "assistant" && event.eventType === "message") {
      const outcome = deriveOutcomeCandidate(event, project);
      if (outcome) pushCandidate({ drafts, seenFingerprints, candidate: outcome });
    }
  }

  return drafts;
}

function deriveObservationCandidate(event: StoredTranscriptEvent): ExtractionCandidateDraft | null {
  const content = event.content.trim();
  if (!content) return null;

  const normalized = content.toLowerCase();
  if (/(we decided|decided to|going with|plan is|we are using|we're using|we will use|we'll use|shipping)/.test(normalized)) {
    return null;
  }

  const dimension = classifyBehavioralDimension(normalized);
  if (!dimension) return null;

  const confidence = dimension === "guard" ? 0.86 : dimension === "style" ? 0.82 : 0.78;

  return {
    candidateType: "observation",
    behavioralDimension: dimension,
    statement: content,
    evidence: content,
    confidence,
    sourceEventIds: [event.id],
    metadata: {
      actor: event.actor,
      eventIndex: event.eventIndex,
      reason: "directive-like user message",
    },
  };
}

function deriveDecisionCandidate(event: StoredTranscriptEvent, project: string | null): ExtractionCandidateDraft | null {
  const content = event.content.trim();
  if (!content) return null;

  const normalized = content.toLowerCase();
  if (!/(we decided|decided to|going with|plan is|we are using|we're using|we will use|we'll use|shipping)/.test(normalized)) {
    return null;
  }

  return {
    candidateType: "decision",
    behavioralDimension: null,
    statement: content,
    evidence: content,
    confidence: 0.84,
    sourceEventIds: [event.id],
    metadata: {
      actor: event.actor,
      eventIndex: event.eventIndex,
      project,
      reason: "decision-style phrase",
    },
  };
}

function deriveFactCandidate(event: StoredTranscriptEvent, project: string | null): ExtractionCandidateDraft | null {
  const content = event.content.trim();
  if (!content) return null;

  const normalized = content.toLowerCase();
  if (!/(depends on|requires|uses|keep refresh tokens|server-side|polling)/.test(normalized)) return null;
  if (/(we decided|decided to|going with|shipping)/.test(normalized)) return null;

  return {
    candidateType: "fact",
    behavioralDimension: null,
    statement: content,
    evidence: content,
    confidence: 0.74,
    sourceEventIds: [event.id],
    metadata: {
      actor: event.actor,
      eventIndex: event.eventIndex,
      project,
      reason: "durable factual phrasing",
    },
  };
}

function deriveOutcomeCandidate(event: StoredTranscriptEvent, project: string | null): ExtractionCandidateDraft | null {
  const content = event.content.trim();
  if (!content) return null;

  const normalized = content.toLowerCase();
  if (!/(done|finished|implemented|fixed|tests passed|shipped|completed)/.test(normalized)) return null;

  return {
    candidateType: "outcome",
    behavioralDimension: null,
    statement: summarizeContent(content, 140),
    evidence: content,
    confidence: 0.72,
    sourceEventIds: [event.id],
    metadata: {
      actor: event.actor,
      eventIndex: event.eventIndex,
      project,
      reason: "completion-style assistant message",
    },
  };
}

function classifyBehavioralDimension(normalized: string): BehavioralDimension | null {
  if (/(always|never|do not|don't|must|must not)/.test(normalized)) return "guard";
  if (/(before editing|before claiming|run .*check|read the file|workflow|inspect)/.test(normalized)) return "workflow";
  if (/(terse|brief|direct|verbose|tone|execution-focused|explain less)/.test(normalized)) return "style";
  if (/(prefer|use chakra|use .* for|keep responses|please use)/.test(normalized)) return "preference";
  if (/(you kept|stop doing|you failed|mistake|annoying)/.test(normalized)) return "failure";
  return null;
}

function pushCandidate({
  drafts,
  seenFingerprints,
  candidate,
}: {
  drafts: ExtractionCandidateDraft[];
  seenFingerprints: Set<string>;
  candidate: ExtractionCandidateDraft;
}) {
  const fingerprint = `${candidate.candidateType}:${candidate.behavioralDimension ?? "none"}:${buildFingerprint(candidate.statement)}`;
  if (!fingerprint || seenFingerprints.has(fingerprint)) return;

  seenFingerprints.add(fingerprint);
  drafts.push(candidate);
}

function mapExtractionRun(row: typeof extractionRuns.$inferSelect): ExtractionRun {
  return {
    id: row.id,
    transcriptId: row.transcriptId,
    project: row.project,
    engineVersion: row.engineVersion,
    candidateCount: row.candidateCount,
    warnings: parseJsonStringArray({ value: row.warningsJson, context: `extraction_run:${row.id}:warnings` }),
    createdAt: row.createdAt,
  };
}

function mapExtractionCandidate(row: typeof extractedCandidates.$inferSelect): StoredExtractionCandidate {
  return {
    id: row.id,
    extractionRunId: row.extractionRunId,
    transcriptId: row.transcriptId,
    project: row.project,
    candidateType: row.candidateType,
    behavioralDimension: row.behavioralDimension,
    statement: row.statement,
    evidence: row.evidence,
    confidence: row.confidence,
    sourceEventIds: parseJsonStringArray({
      value: row.sourceEventIdsJson,
      context: `extracted_candidate:${row.id}:source_event_ids`,
    }),
    metadata: parseCandidateMetadata({ value: row.metadataJson, context: `extracted_candidate:${row.id}:metadata` }),
    reviewStatus: row.reviewStatus,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt,
    promotedAt: row.promotedAt,
    createdAt: row.createdAt,
  };
}

function parseCandidateMetadata({ value, context }: { value: string; context: string }) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`Failed to parse extracted candidate metadata for ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {} satisfies Record<string, unknown>;
}
