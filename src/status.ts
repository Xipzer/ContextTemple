import { sql } from "drizzle-orm";

import type { TempleDatabase } from "./db.ts";
import { DatabaseQueryError } from "./errors.ts";
import {
  behavioralRules,
  episodicMemories,
  extractionRuns,
  extractedCandidates,
  memoryConflicts,
  observations,
  promotionRuns,
  retrievalEvents,
  ruleConflicts,
  transcriptEvents,
  transcriptSources,
} from "./schema.ts";
import type { TempleStatus } from "./types.ts";

export async function getTempleStatus({ temple }: { temple: TempleDatabase }) {
  const counts = await Promise.all([
    temple.db.select({ count: sql<number>`count(*)` }).from(observations),
    temple.db
      .select({ count: sql<number>`count(*)` })
      .from(behavioralRules)
      .where(sql`${behavioralRules.status} = 'active'`),
    temple.db.select({ count: sql<number>`count(*)` }).from(episodicMemories),
    temple.db.select({ count: sql<number>`count(*)` }).from(retrievalEvents),
    temple.db.select({ count: sql<number>`count(*)` }).from(transcriptSources),
    temple.db.select({ count: sql<number>`count(*)` }).from(transcriptEvents),
    temple.db.select({ count: sql<number>`count(*)` }).from(extractionRuns),
    temple.db.select({ count: sql<number>`count(*)` }).from(extractedCandidates),
    temple.db.select({ count: sql<number>`count(*)` }).from(promotionRuns),
    temple.db.select({ count: sql<number>`count(*)` }).from(ruleConflicts),
    temple.db.select({ count: sql<number>`count(*)` }).from(memoryConflicts),
  ]).catch((cause) => new DatabaseQueryError({ operation: "compute temple status", cause }));

  if (counts instanceof Error) return counts;

  const [
    observationCount,
    activeRuleCount,
    episodicCount,
    retrievalCount,
    transcriptCount,
    transcriptEventCount,
    extractionRunCount,
    extractedCandidateCount,
    promotionRunCount,
    ruleConflictCount,
    memoryConflictCount,
  ] = counts;

  return {
    observations: Number(observationCount[0]?.count ?? 0),
    activeRules: Number(activeRuleCount[0]?.count ?? 0),
    episodicMemories: Number(episodicCount[0]?.count ?? 0),
    retrievalEvents: Number(retrievalCount[0]?.count ?? 0),
    transcripts: Number(transcriptCount[0]?.count ?? 0),
    transcriptEvents: Number(transcriptEventCount[0]?.count ?? 0),
    extractionRuns: Number(extractionRunCount[0]?.count ?? 0),
    extractedCandidates: Number(extractedCandidateCount[0]?.count ?? 0),
    promotionRuns: Number(promotionRunCount[0]?.count ?? 0),
    ruleConflicts: Number(ruleConflictCount[0]?.count ?? 0),
    memoryConflicts: Number(memoryConflictCount[0]?.count ?? 0),
  } satisfies TempleStatus;
}
