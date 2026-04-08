import fs from "node:fs/promises";
import path from "node:path";

import type { TempleDatabase } from "../db.ts";
import { FileReadError, ValidationError } from "../errors.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";
import { runConsolidationCycle } from "../consolidation.ts";

export type SessionAdapterResult = {
  sessionId: string;
  transcriptId: string | null;
  extractionRunId: string | null;
  promotionRunId: string | null;
  consolidated: boolean;
  skipped: boolean;
  reason: string | null;
};

export async function ingestKimakiSession({
  temple,
  sessionId,
  project,
  sessionMarkdownPath,
  autoPromote = true,
  autoConsolidate = true,
}: {
  temple: TempleDatabase;
  sessionId: string;
  project?: string | null;
  sessionMarkdownPath: string;
  autoPromote?: boolean;
  autoConsolidate?: boolean;
}) {
  const absolutePath = path.resolve(sessionMarkdownPath);
  const fileExists = await fs.access(absolutePath).then(() => true).catch(() => false);
  if (!fileExists) {
    return new FileReadError({ path: absolutePath });
  }

  const imported = await importTranscript({
    temple,
    filePath: absolutePath,
    project,
    sourceLabel: `kimaki-session:${sessionId}`,
    format: "auto",
  });
  if (imported instanceof Error) return imported;

  if (imported.duplicate) {
    return {
      sessionId,
      transcriptId: imported.transcript.id,
      extractionRunId: null,
      promotionRunId: null,
      consolidated: false,
      skipped: true,
      reason: "transcript already imported",
    } satisfies SessionAdapterResult;
  }

  const extraction = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
  if (extraction instanceof Error) return extraction;

  let promotionRunId: string | null = null;
  if (autoPromote) {
    const promotion = await promoteExtractionRun({ temple, extractionRunId: extraction.run.id });
    if (promotion instanceof Error) return promotion;
    promotionRunId = promotion.run.id;
  }

  let consolidated = false;
  if (autoConsolidate) {
    const consolidation = await runConsolidationCycle({ temple, project });
    if (consolidation instanceof Error) return consolidation;
    consolidated = true;
  }

  return {
    sessionId,
    transcriptId: imported.transcript.id,
    extractionRunId: extraction.run.id,
    promotionRunId,
    consolidated,
    skipped: false,
    reason: null,
  } satisfies SessionAdapterResult;
}

export async function ingestKimakiSessionFromReadCommand({
  temple,
  sessionId,
  project,
  tmpDir,
  autoPromote = true,
  autoConsolidate = true,
}: {
  temple: TempleDatabase;
  sessionId: string;
  project?: string | null;
  tmpDir: string;
  autoPromote?: boolean;
  autoConsolidate?: boolean;
}) {
  const sessionPath = path.join(tmpDir, `${sessionId}.md`);
  const fileExists = await fs.access(sessionPath).then(() => true).catch(() => false);
  if (!fileExists) {
    return new ValidationError({ field: "sessionId", reason: `session markdown not found at ${sessionPath}` });
  }

  return ingestKimakiSession({
    temple,
    sessionId,
    project,
    sessionMarkdownPath: sessionPath,
    autoPromote,
    autoConsolidate,
  });
}

export async function batchIngestSessionDirectory({
  temple,
  directory,
  project,
  autoPromote = true,
  autoConsolidate = true,
}: {
  temple: TempleDatabase;
  directory: string;
  project?: string | null;
  autoPromote?: boolean;
  autoConsolidate?: boolean;
}) {
  const absoluteDir = path.resolve(directory);
  const entries = await fs.readdir(absoluteDir).catch(
    (cause) => new FileReadError({ path: absoluteDir, cause }),
  );
  if (entries instanceof Error) return entries;

  const markdownFiles = entries.filter((entry) => entry.endsWith(".md") || entry.endsWith(".txt") || entry.endsWith(".jsonl") || entry.endsWith(".json"));
  const results: SessionAdapterResult[] = [];

  for (const file of markdownFiles) {
    const sessionId = path.basename(file, path.extname(file));
    const result = await ingestKimakiSession({
      temple,
      sessionId,
      project,
      sessionMarkdownPath: path.join(absoluteDir, file),
      autoPromote,
      autoConsolidate: false,
    });
    if (result instanceof Error) return result;
    results.push(result);
  }

  if (autoConsolidate && results.some((result) => !result.skipped)) {
    const consolidation = await runConsolidationCycle({ temple, project });
    if (consolidation instanceof Error) return consolidation;
  }

  return results;
}
