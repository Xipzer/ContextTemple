import fs from "node:fs/promises";
import path from "node:path";

import type { TempleDatabase } from "../db.ts";
import { openTempleDatabase } from "../db.ts";
import { ensureTempleHome } from "../config.ts";
import { FileReadError, ValidationError } from "../errors.ts";
import {
  behavioralRules,
  episodicMemories,
  memoryConflicts,
  observations,
  promotionRuns,
  ruleConflicts,
  transcriptSources,
} from "../schema.ts";
import { DatabaseQueryError } from "../errors.ts";
import { eq } from "drizzle-orm";

export async function exportTempleSnapshot({
  temple,
  outputPath,
}: {
  temple: TempleDatabase;
  outputPath: string;
}) {
  const absoluteOutputPath = path.resolve(outputPath);
  const parentDir = path.dirname(absoluteOutputPath);
  const mkdirResult = await fs.mkdir(parentDir, { recursive: true }).catch((cause) => new FileReadError({ path: parentDir, cause }));
  if (mkdirResult instanceof Error) return mkdirResult;

  await temple.close();

  const copyResult = await fs.copyFile(temple.paths.dbPath, absoluteOutputPath).catch(
    (cause) => new FileReadError({ path: absoluteOutputPath, cause }),
  );
  if (copyResult instanceof Error) return copyResult;

  return {
    outputPath: absoluteOutputPath,
  };
}

export async function importTempleSnapshot({
  homeDir,
  snapshotPath,
}: {
  homeDir?: string;
  snapshotPath: string;
}) {
  const paths = await ensureTempleHome({ homeDir });
  if (paths instanceof Error) return paths;

  const copyResult = await fs.copyFile(path.resolve(snapshotPath), paths.dbPath).catch(
    (cause) => new FileReadError({ path: snapshotPath, cause }),
  );
  if (copyResult instanceof Error) return copyResult;

  const temple = await openTempleDatabase({ homeDir: paths.homeDir });
  if (temple instanceof Error) return temple;
  await temple.close();

  return {
    dbPath: paths.dbPath,
  };
}

export async function purgeProjectData({
  temple,
  project,
}: {
  temple: TempleDatabase;
  project: string;
}) {
  const trimmedProject = project.trim();
  if (!trimmedProject) {
    return new ValidationError({ field: "project", reason: "must not be empty" });
  }

  const deleted = {
    observations: 0,
    behavioralRules: 0,
    episodicMemories: 0,
    transcripts: 0,
    promotionRuns: 0,
    ruleConflicts: 0,
    memoryConflicts: 0,
  };

  const ruleConflictsDeleted = await temple.db.delete(ruleConflicts).where(eq(ruleConflicts.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "purge project rule conflicts", cause }),
  );
  if (ruleConflictsDeleted instanceof Error) return ruleConflictsDeleted;

  const memoryConflictsDeleted = await temple.db.delete(memoryConflicts).where(eq(memoryConflicts.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "purge project memory conflicts", cause }),
  );
  if (memoryConflictsDeleted instanceof Error) return memoryConflictsDeleted;

  const promotionRunsDeleted = await temple.db.delete(promotionRuns).where(eq(promotionRuns.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "purge project promotion runs", cause }),
  );
  if (promotionRunsDeleted instanceof Error) return promotionRunsDeleted;

  const transcriptRows = await temple.db.select({ id: transcriptSources.id }).from(transcriptSources).where(eq(transcriptSources.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "fetch project transcripts for purge", cause }),
  );
  if (transcriptRows instanceof Error) return transcriptRows;

  for (const transcript of transcriptRows) {
    const deleteTranscript = await temple.db.delete(transcriptSources).where(eq(transcriptSources.id, transcript.id)).catch(
      (cause) => new DatabaseQueryError({ operation: "purge project transcript", cause }),
    );
    if (deleteTranscript instanceof Error) return deleteTranscript;
    deleted.transcripts += 1;
  }

  const memoryRows = await temple.db.select({ id: episodicMemories.id }).from(episodicMemories).where(eq(episodicMemories.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "fetch project memories for purge", cause }),
  );
  if (memoryRows instanceof Error) return memoryRows;

  for (const memory of memoryRows) {
    const deleteMemory = await temple.db.delete(episodicMemories).where(eq(episodicMemories.id, memory.id)).catch(
      (cause) => new DatabaseQueryError({ operation: "purge project memory", cause }),
    );
    if (deleteMemory instanceof Error) return deleteMemory;
    deleted.episodicMemories += 1;
  }

  const observationsDeleted = await temple.db.delete(observations).where(eq(observations.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "purge project observations", cause }),
  );
  if (observationsDeleted instanceof Error) return observationsDeleted;

  const behavioralRulesDeleted = await temple.db.delete(behavioralRules).where(eq(behavioralRules.project, trimmedProject)).catch(
    (cause) => new DatabaseQueryError({ operation: "purge project behavioral rules", cause }),
  );
  if (behavioralRulesDeleted instanceof Error) return behavioralRulesDeleted;

  deleted.observations = Number(observationsDeleted.rowsAffected ?? 0);
  deleted.behavioralRules = Number(behavioralRulesDeleted.rowsAffected ?? 0);
  deleted.promotionRuns = Number(promotionRunsDeleted.rowsAffected ?? 0);
  deleted.ruleConflicts = Number(ruleConflictsDeleted.rowsAffected ?? 0);
  deleted.memoryConflicts = Number(memoryConflictsDeleted.rowsAffected ?? 0);

  return deleted;
}
