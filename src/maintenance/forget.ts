import { and, eq, lt } from "drizzle-orm";

import type { TempleDatabase } from "../db.ts";
import { DatabaseQueryError } from "../errors.ts";
import { episodicMemories } from "../schema.ts";

export async function runActiveForgetting({
  temple,
  project,
  usefulnessThreshold = 0.25,
  maxAgeDays = 90,
  dryRun = false,
}: {
  temple: TempleDatabase;
  project?: string | null;
  usefulnessThreshold?: number;
  maxAgeDays?: number;
  dryRun?: boolean;
}) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const rows = await (
    project?.trim()
      ? temple.db
          .select()
          .from(episodicMemories)
          .where(and(eq(episodicMemories.project, project.trim()), eq(episodicMemories.status, "active")))
      : temple.db.select().from(episodicMemories).where(eq(episodicMemories.status, "active"))
  ).catch((cause) => new DatabaseQueryError({ operation: "fetch memories for active forgetting", cause }));
  if (rows instanceof Error) return rows;

  const archiveIds = rows
    .filter((row) => row.positiveFeedbackCount + row.negativeFeedbackCount > 0)
    .filter((row) => row.usefulnessScore <= usefulnessThreshold)
    .filter((row) => row.updatedAt <= cutoff)
    .filter((row) => row.accessCount <= 1)
    .map((row) => row.id);

  if (!dryRun) {
    for (const id of archiveIds) {
      const updateResult = await temple.db
        .update(episodicMemories)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(episodicMemories.id, id))
        .catch((cause) => new DatabaseQueryError({ operation: "archive low-value memory", cause }));
      if (updateResult instanceof Error) return updateResult;
    }
  }

  return {
    archivedMemoryIds: archiveIds,
    dryRun,
    usefulnessThreshold,
    maxAgeDays,
  };
}
