import crypto from "node:crypto";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { TempleDatabase } from "../db.ts";
import { DatabaseQueryError, FileReadError, JsonParsingError } from "../errors.ts";
import { transcriptEvents, transcriptSources } from "../schema.ts";
import { parseTranscriptText } from "./normalize.ts";
import type {
  ParsedTranscriptFile,
  StoredTranscript,
  StoredTranscriptEvent,
  TranscriptImportResult,
  TranscriptRequestedFormat,
} from "./types.ts";
import { stringifyJson } from "../utils.ts";
import * as errore from "errore";

export async function parseTranscriptFile({
  filePath,
  format = "auto",
}: {
  filePath: string;
  format?: TranscriptRequestedFormat;
}) {
  const fileText = await fs.readFile(filePath, "utf8").catch((cause) => new FileReadError({ path: filePath, cause }));
  if (fileText instanceof Error) return fileText;

  const parsed = parseTranscriptText({ text: fileText, format, sourcePath: filePath });
  if (parsed instanceof Error) return parsed;

  return {
    ...parsed,
    sourcePath: filePath,
    checksum: crypto.createHash("sha256").update(fileText).digest("hex"),
  } satisfies ParsedTranscriptFile;
}

export async function importTranscript({
  temple,
  filePath,
  project,
  sourceLabel,
  format = "auto",
}: {
  temple: TempleDatabase;
  filePath: string;
  project?: string | null;
  sourceLabel?: string | null;
  format?: TranscriptRequestedFormat;
}) {
  const parsed = await parseTranscriptFile({ filePath, format });
  if (parsed instanceof Error) return parsed;

  const normalizedProject = project?.trim() || null;
  const existingRows = await temple.db
    .select()
    .from(transcriptSources)
    .where(
      normalizedProject
        ? and(eq(transcriptSources.checksum, parsed.checksum), eq(transcriptSources.project, normalizedProject))
        : and(eq(transcriptSources.checksum, parsed.checksum), isNull(transcriptSources.project)),
    )
    .catch((cause) => new DatabaseQueryError({ operation: "find existing transcript import", cause }));
  if (existingRows instanceof Error) return existingRows;

  const existing = existingRows[0];
  if (existing) {
    return {
      duplicate: true,
      transcript: mapTranscript(existing),
      eventsInserted: 0,
      warnings: parsed.warnings,
    } satisfies TranscriptImportResult;
  }

  const now = new Date();
  const transcriptId = randomUUID();
  const transcriptRow = {
    id: transcriptId,
    project: normalizedProject,
    sourcePath: filePath,
    sourceLabel: sourceLabel?.trim() || null,
    format: parsed.format,
    checksum: parsed.checksum,
    eventCount: parsed.events.length,
    importedAt: now,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
  } satisfies typeof transcriptSources.$inferInsert;

  const insertTranscriptResult = await temple.db.insert(transcriptSources).values(transcriptRow).catch(
    (cause) => new DatabaseQueryError({ operation: "insert transcript source", cause }),
  );
  if (insertTranscriptResult instanceof Error) return insertTranscriptResult;

  const eventRows: Array<typeof transcriptEvents.$inferInsert> = [];

  for (const event of parsed.events) {
    const metadataJson = stringifyJson({
      value: event.metadata,
      context: `transcript_event:${transcriptId}:${event.eventIndex}`,
    });
    if (metadataJson instanceof Error) return metadataJson;

    eventRows.push({
      id: randomUUID(),
      transcriptId,
      eventIndex: event.eventIndex,
      actor: event.actor,
      eventType: event.eventType,
      name: event.name,
      content: event.content,
      occurredAt: event.occurredAt,
      metadataJson,
    });
  }

  if (eventRows.length > 0) {
    const insertEventsResult = await temple.db.insert(transcriptEvents).values(eventRows).catch(
      (cause) => new DatabaseQueryError({ operation: "insert transcript events", cause }),
    );
    if (insertEventsResult instanceof Error) return insertEventsResult;
  }

  return {
    duplicate: false,
    transcript: mapTranscript(transcriptRow),
    eventsInserted: eventRows.length,
    warnings: parsed.warnings,
  } satisfies TranscriptImportResult;
}

export async function listTranscripts({
  temple,
  project,
  limit = 20,
}: {
  temple: TempleDatabase;
  project?: string | null;
  limit?: number;
}) {
  const normalizedProject = project?.trim() || null;
  const rows = await (
    normalizedProject
      ? temple.db
          .select()
          .from(transcriptSources)
          .where(eq(transcriptSources.project, normalizedProject))
          .orderBy(desc(transcriptSources.importedAt))
          .limit(limit)
      : temple.db.select().from(transcriptSources).orderBy(desc(transcriptSources.importedAt)).limit(limit)
  ).catch((cause) => new DatabaseQueryError({ operation: "list transcript sources", cause }));
  if (rows instanceof Error) return rows;

  return rows.map(mapTranscript);
}

export async function listTranscriptEvents({
  temple,
  transcriptId,
  limit,
}: {
  temple: TempleDatabase;
  transcriptId: string;
  limit?: number;
}) {
  const rows = await (limit
    ? temple.db
        .select()
        .from(transcriptEvents)
        .where(eq(transcriptEvents.transcriptId, transcriptId))
        .orderBy(asc(transcriptEvents.eventIndex))
        .limit(limit)
    : temple.db
        .select()
        .from(transcriptEvents)
        .where(eq(transcriptEvents.transcriptId, transcriptId))
        .orderBy(asc(transcriptEvents.eventIndex))).catch(
    (cause) => new DatabaseQueryError({ operation: "list transcript events", cause }),
  );
  if (rows instanceof Error) return rows;

  return rows.map(mapTranscriptEvent);
}

function mapTranscript(row: typeof transcriptSources.$inferSelect): StoredTranscript {
  return {
    id: row.id,
    project: row.project,
    sourcePath: row.sourcePath,
    sourceLabel: row.sourceLabel,
    format: row.format,
    checksum: row.checksum,
    eventCount: row.eventCount,
    importedAt: row.importedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function mapTranscriptEvent(row: typeof transcriptEvents.$inferSelect): StoredTranscriptEvent {
  const metadata = parseMetadata({
    value: row.metadataJson,
    context: `transcript_event:${row.id}`,
  });

  return {
    id: row.id,
    transcriptId: row.transcriptId,
    eventIndex: row.eventIndex,
    actor: row.actor,
    eventType: row.eventType,
    name: row.name,
    content: row.content,
    occurredAt: row.occurredAt,
    metadata,
  };
}

function parseMetadata({ value, context }: { value: string; context: string }) {
  const parsed = errore.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => new JsonParsingError({ context, cause }),
  });

  if (parsed instanceof Error) {
    console.warn(parsed.message);
    return {} satisfies Record<string, unknown>;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`Stored JSON for ${context} was not an object`);
    return {} satisfies Record<string, unknown>;
  }

  return parsed as Record<string, unknown>;
}
