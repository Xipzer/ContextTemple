import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { recordObservation } from "../behavioral.ts";
import type { TempleDatabase } from "../db.ts";
import { rememberEpisode } from "../episodic.ts";
import { DatabaseQueryError, ValidationError } from "../errors.ts";
import { episodicMemories, extractedCandidates, extractionRuns, observations, promotionRuns } from "../schema.ts";
import { parseJsonStringArray, stringifyJson } from "../utils.ts";
import type { PromotionResult, PromotionRun, StoredExtractionCandidate } from "../extract/types.ts";
import { listExtractionCandidates } from "../extract/candidates.ts";

const promotionPolicyVersion = "candidate-promotion-v1";

export async function promoteExtractionRun({
  temple,
  extractionRunId,
  requireApproval = false,
}: {
  temple: TempleDatabase;
  extractionRunId: string;
  requireApproval?: boolean;
}) {
  const runRows = await temple.db
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.id, extractionRunId))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch extraction run for promotion", cause }));
  if (runRows instanceof Error) return runRows;

  const extractionRun = runRows[0];
  if (!extractionRun) {
    return new ValidationError({ field: "extractionRunId", reason: "was not found" });
  }

  const existingRows = await temple.db
    .select()
    .from(promotionRuns)
    .where(eq(promotionRuns.extractionRunId, extractionRunId))
    .orderBy(desc(promotionRuns.createdAt))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch promotion runs", cause }));
  if (existingRows instanceof Error) return existingRows;

  const existing = existingRows.find((row) => row.policyVersion === promotionPolicyVersion);
  if (existing) {
    return {
      duplicate: true,
      run: mapPromotionRun(existing),
      promotedObservationIds: parseJsonStringArray({
        value: existing.promotedObservationIdsJson,
        context: `promotion_run:${existing.id}:observation_ids`,
      }),
      promotedMemoryIds: parseJsonStringArray({
        value: existing.promotedMemoryIdsJson,
        context: `promotion_run:${existing.id}:memory_ids`,
      }),
      skippedCandidateIds: [],
    } satisfies PromotionResult;
  }

  const candidates = await listExtractionCandidates({ temple, extractionRunId });
  if (candidates instanceof Error) return candidates;

  const promotedObservationIds: string[] = [];
  const promotedMemoryIds: string[] = [];
  const skippedCandidateIds: string[] = [];

  for (const candidate of candidates) {
    if (candidate.reviewStatus === "rejected") {
      skippedCandidateIds.push(candidate.id);
      continue;
    }

    if (requireApproval && candidate.reviewStatus !== "approved") {
      skippedCandidateIds.push(candidate.id);
      continue;
    }

    if (candidate.candidateType === "observation" && candidate.behavioralDimension) {
      const observationRows = await temple.db
        .select({ id: observations.id })
        .from(observations)
        .where(eq(observations.sourceCandidateId, candidate.id))
        .catch((cause) => new DatabaseQueryError({ operation: "check promoted observation duplicate", cause }));
      if (observationRows instanceof Error) return observationRows;

      const existingObservation = observationRows[0];
      if (existingObservation) {
        promotedObservationIds.push(existingObservation.id);
        await markCandidatePromoted({ temple, candidateId: candidate.id });
        continue;
      }

      const observation = await recordObservation({
        temple,
        input: {
          project: candidate.project,
          dimension: candidate.behavioralDimension,
          statement: candidate.statement,
          evidence: candidate.evidence,
          confidence: candidate.confidence,
          sourceCandidateId: candidate.id,
        },
      });
      if (observation instanceof Error) return observation;

      promotedObservationIds.push(observation.id);
      await markCandidatePromoted({ temple, candidateId: candidate.id });
      continue;
    }

    if (candidate.candidateType === "decision" || candidate.candidateType === "fact" || candidate.candidateType === "outcome") {
      const source = buildMemorySource(candidate);
      const existingMemories = await temple.db
        .select()
        .from(episodicMemories)
        .where(eq(episodicMemories.source, source))
        .catch((cause) => new DatabaseQueryError({ operation: "check promoted memory duplicate", cause }));
      if (existingMemories instanceof Error) return existingMemories;

      const existingMemory = existingMemories[0];
      if (existingMemory) {
        promotedMemoryIds.push(existingMemory.id);
        await markCandidatePromoted({ temple, candidateId: candidate.id });
        continue;
      }

      const memory = await rememberEpisode({
        temple,
        input: {
          project: candidate.project,
          source,
          content: candidate.evidence,
          tags: buildMemoryTags(candidate),
          salience: buildMemorySalience(candidate),
        },
      });
      if (memory instanceof Error) return memory;

      promotedMemoryIds.push(memory.id);
      await markCandidatePromoted({ temple, candidateId: candidate.id });
    }
  }

  const promotedObservationIdsJson = stringifyJson({
    value: promotedObservationIds,
    context: `promotion_run:${extractionRunId}:promoted_observation_ids`,
  });
  if (promotedObservationIdsJson instanceof Error) return promotedObservationIdsJson;

  const promotedMemoryIdsJson = stringifyJson({
    value: promotedMemoryIds,
    context: `promotion_run:${extractionRunId}:promoted_memory_ids`,
  });
  if (promotedMemoryIdsJson instanceof Error) return promotedMemoryIdsJson;

  const runRow = {
    id: randomUUID(),
    extractionRunId,
    project: extractionRun.project,
    policyVersion: promotionPolicyVersion,
    promotedObservationIdsJson,
    promotedMemoryIdsJson,
    createdAt: new Date(),
  } satisfies typeof promotionRuns.$inferInsert;

  const insertRunResult = await temple.db.insert(promotionRuns).values(runRow).catch(
    (cause) => new DatabaseQueryError({ operation: "insert promotion run", cause }),
  );
  if (insertRunResult instanceof Error) return insertRunResult;

  return {
    duplicate: false,
    run: mapPromotionRun(runRow),
    promotedObservationIds,
    promotedMemoryIds,
    skippedCandidateIds,
  } satisfies PromotionResult;
}

export async function listPromotionRuns({
  temple,
  project,
  extractionRunId,
  limit = 20,
}: {
  temple: TempleDatabase;
  project?: string | null;
  extractionRunId?: string | null;
  limit?: number;
}) {
  const rows = await temple.db
    .select()
    .from(promotionRuns)
    .orderBy(desc(promotionRuns.createdAt))
    .limit(limit)
    .catch((cause) => new DatabaseQueryError({ operation: "list promotion runs", cause }));
  if (rows instanceof Error) return rows;

  return rows
    .filter((row) => (project?.trim() ? row.project === project.trim() : true))
    .filter((row) => (extractionRunId?.trim() ? row.extractionRunId === extractionRunId.trim() : true))
    .map(mapPromotionRun);
}

function mapPromotionRun(row: typeof promotionRuns.$inferSelect): PromotionRun {
  return {
    id: row.id,
    extractionRunId: row.extractionRunId,
    project: row.project,
    policyVersion: row.policyVersion,
    promotedObservationIds: parseJsonStringArray({
      value: row.promotedObservationIdsJson,
      context: `promotion_run:${row.id}:promoted_observation_ids`,
    }),
    promotedMemoryIds: parseJsonStringArray({
      value: row.promotedMemoryIdsJson,
      context: `promotion_run:${row.id}:promoted_memory_ids`,
    }),
    createdAt: row.createdAt,
  };
}

function buildMemorySource(candidate: StoredExtractionCandidate) {
  return `extracted-candidate:${candidate.id}`;
}

function buildMemoryTags(candidate: StoredExtractionCandidate) {
  return [candidate.candidateType, candidate.project ?? "unscoped"];
}

function buildMemorySalience(candidate: StoredExtractionCandidate) {
  if (candidate.candidateType === "decision") return 8;
  if (candidate.candidateType === "fact") return 7;
  return 6;
}

async function markCandidatePromoted({
  temple,
  candidateId,
}: {
  temple: TempleDatabase;
  candidateId: string;
}) {
  const result = await temple.db
    .update(extractedCandidates)
    .set({ reviewStatus: "promoted", promotedAt: new Date() })
    .where(eq(extractedCandidates.id, candidateId))
    .catch((cause) => new DatabaseQueryError({ operation: "mark extraction candidate promoted", cause }));
  return result instanceof Error ? result : null;
}
