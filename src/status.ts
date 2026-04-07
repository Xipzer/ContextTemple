import { sql } from "drizzle-orm";

import type { TempleDatabase } from "./db.ts";
import { DatabaseQueryError } from "./errors.ts";
import { behavioralRules, episodicMemories, observations, retrievalEvents } from "./schema.ts";
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
  ]).catch((cause) => new DatabaseQueryError({ operation: "compute temple status", cause }));

  if (counts instanceof Error) return counts;

  const [observationCount, activeRuleCount, episodicCount, retrievalCount] = counts;

  return {
    observations: Number(observationCount[0]?.count ?? 0),
    activeRules: Number(activeRuleCount[0]?.count ?? 0),
    episodicMemories: Number(episodicCount[0]?.count ?? 0),
    retrievalEvents: Number(retrievalCount[0]?.count ?? 0),
  } satisfies TempleStatus;
}
