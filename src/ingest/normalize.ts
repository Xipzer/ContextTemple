import * as errore from "errore";

import { TranscriptParseError, UnsupportedTranscriptFormatError } from "../errors.ts";
import { finalizeParsedTranscript } from "./events.ts";
import type {
  CanonicalTranscriptEvent,
  ParsedTranscript,
  TranscriptActor,
  TranscriptEventType,
  TranscriptRequestedFormat,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

export function parseTranscriptText({
  text,
  format,
  sourcePath,
}: {
  text: string;
  format: TranscriptRequestedFormat;
  sourcePath: string;
}) {
  if (format === "jsonl") {
    const parsed = parseJsonlTranscript({ text, sourcePath });
    if (parsed instanceof Error) return parsed;
    if (parsed) return parsed;
    return new UnsupportedTranscriptFormatError({ path: sourcePath });
  }

  if (format === "chat-json") {
    const parsed = parseChatJsonTranscript({ text, sourcePath });
    if (parsed instanceof Error) return parsed;
    if (parsed) return parsed;
    return new UnsupportedTranscriptFormatError({ path: sourcePath });
  }

  if (format === "prefixed-text") {
    const parsed = parsePrefixedTextTranscript({ text, sourcePath });
    if (parsed instanceof Error) return parsed;
    if (parsed) return parsed;
    return new UnsupportedTranscriptFormatError({ path: sourcePath });
  }

  const attempts = [
    parseJsonlTranscript({ text, sourcePath }),
    parseChatJsonTranscript({ text, sourcePath }),
    parsePrefixedTextTranscript({ text, sourcePath }),
  ];

  for (const attempt of attempts) {
    if (attempt instanceof Error) continue;
    if (attempt) return attempt;
  }

  const firstError = attempts.find((attempt): attempt is Error => attempt instanceof Error);
  if (firstError) return firstError;

  return new UnsupportedTranscriptFormatError({ path: sourcePath });
}

function parseJsonlTranscript({ text, sourcePath }: { text: string; sourcePath: string }) {
  const lines = text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0);

  if (lines.length === 0) return null;

  const events: CanonicalTranscriptEvent[] = [];
  const warnings: string[] = [];

  for (const { line, lineNumber } of lines) {
    const parsed = errore.try({
      try: () => JSON.parse(line) as unknown,
      catch: (cause) => new TranscriptParseError({ path: sourcePath, reason: `invalid JSONL on line ${lineNumber}`, cause }),
    });
    if (parsed instanceof Error) return parsed;

    const event = normalizeJsonLikeRecord({ value: parsed, sourcePath, lineNumber });
    if (event instanceof Error) return event;
    if (!event) {
      warnings.push(`Skipped unsupported JSONL event on line ${lineNumber}`);
      continue;
    }
    events.push(event);
  }

  if (events.length === 0) return null;
  return finalizeParsedTranscript({ format: "jsonl", events, warnings });
}

function parseChatJsonTranscript({ text, sourcePath }: { text: string; sourcePath: string }) {
  const firstChar = text.trim().at(0);
  if (firstChar !== "{" && firstChar !== "[") return null;

  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new TranscriptParseError({ path: sourcePath, reason: "invalid JSON transcript", cause }),
  });
  if (parsed instanceof Error) return null;

  const records = extractMessageArray(parsed);
  if (!records) return null;

  const events: CanonicalTranscriptEvent[] = [];

  for (const record of records) {
    const event = normalizeJsonLikeRecord({ value: record, sourcePath });
    if (event instanceof Error) return event;
    if (!event) continue;
    events.push(event);
  }

  if (events.length === 0) return null;
  return finalizeParsedTranscript({ format: "chat-json", events });
}

function parsePrefixedTextTranscript({ text, sourcePath }: { text: string; sourcePath: string }) {
  const lines = text.split(/\r?\n/);
  const events: CanonicalTranscriptEvent[] = [];
  let current: Omit<CanonicalTranscriptEvent, "eventIndex"> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = /^(System|User|Assistant|Tool)(?:\(([^)]+)\))?:\s*(.*)$/.exec(line);

    if (match) {
      if (current && current.content.trim()) {
        events.push({ ...current, eventIndex: events.length });
      }

      const rawActor = match[1];
      if (!rawActor) continue;

      const actor = rawActor.toLowerCase() as TranscriptActor;
      current = {
        actor,
        eventType: actor === "tool" ? "tool_result" : "message",
        name: match[2] ?? null,
        content: match[3]?.trim() ?? "",
        occurredAt: null,
        metadata: { parser: "prefixed-text" },
      };
      continue;
    }

    if (!current) continue;
    current.content = current.content ? `${current.content}\n${line}`.trim() : line.trim();
  }

  if (current && current.content.trim()) {
    events.push({ ...current, eventIndex: events.length });
  }

  if (events.length === 0) return null;
  return finalizeParsedTranscript({ format: "prefixed-text", events });
}

function extractMessageArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  const candidate = value.messages;
  return Array.isArray(candidate) ? candidate : null;
}

function normalizeJsonLikeRecord({
  value,
  sourcePath,
  lineNumber,
}: {
  value: unknown;
  sourcePath: string;
  lineNumber?: number;
}) {
  if (!isRecord(value)) return null;

  const wrappedMessage = isRecord(value.message) ? value.message : null;
  const record = wrappedMessage ?? value;
  const rawType = getString(record.type) ?? getString(value.type);

  if (rawType === "tool_use") {
    return createEvent({
      actor: "tool",
      eventType: "tool_use",
      name: getString(record.name) ?? getString(value.name),
      content: extractContent(record.input ?? record.arguments ?? record.content),
      occurredAt: extractTimestamp(record) ?? extractTimestamp(value),
      metadata: buildMetadata({ rawType, lineNumber }),
    });
  }

  if (rawType === "tool_result") {
    return createEvent({
      actor: "tool",
      eventType: "tool_result",
      name: getString(record.name) ?? getString(value.name),
      content: extractContent(record.output ?? record.result ?? record.content),
      occurredAt: extractTimestamp(record) ?? extractTimestamp(value),
      metadata: buildMetadata({ rawType, lineNumber }),
    });
  }

  const actor = parseActor(getString(record.role) ?? getString(value.role) ?? getString(record.actor));
  if (!actor) return null;

  return createEvent({
    actor,
    eventType: "message",
    name: getString(record.name) ?? null,
    content: extractContent(record.content),
    occurredAt: extractTimestamp(record) ?? extractTimestamp(value),
    metadata: buildMetadata({ rawType, lineNumber }),
  });
}

function createEvent({
  actor,
  eventType,
  name,
  content,
  occurredAt,
  metadata,
}: {
  actor: TranscriptActor;
  eventType: TranscriptEventType;
  name: string | null;
  content: string;
  occurredAt: Date | null;
  metadata: Record<string, unknown>;
}) {
  return {
    eventIndex: 0,
    actor,
    eventType,
    name,
    content: content.trim(),
    occurredAt,
    metadata,
  } satisfies CanonicalTranscriptEvent;
}

function parseActor(value: string | null) {
  if (!value) return null;
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value;
  return null;
}

function extractContent(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((item) => extractContent(item)).filter(Boolean).join("\n\n").trim();
  }

  if (!isRecord(value)) return stringifyUnknown(value);

  const directText = getString(value.text);
  if (directText) return directText;

  const prioritized = [value.content, value.input, value.output, value.result, value.value, value.arguments];
  for (const candidate of prioritized) {
    const extracted = extractContent(candidate);
    if (extracted) return extracted;
  }

  return stringifyUnknown(value);
}

function extractTimestamp(record: JsonRecord) {
  const candidates = [record.timestamp, record.created_at, record.createdAt, record.occurred_at, record.occurredAt];
  for (const candidate of candidates) {
    const timestamp = coerceTimestamp(candidate);
    if (timestamp) return timestamp;
  }
  return null;
}

function coerceTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1_000_000_000_000 ? value : value * 1000);
  }
  if (typeof value !== "string") return null;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return new Date(asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000);
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function buildMetadata({
  rawType,
  lineNumber,
}: {
  rawType: string | null;
  lineNumber?: number;
}) {
  return {
    rawType,
    lineNumber: lineNumber ?? null,
  } satisfies Record<string, unknown>;
}

function stringifyUnknown(value: unknown) {
  if (value === null || value === undefined) return "";

  return errore.try({
    try: () => JSON.stringify(value),
    catch: () => "",
  });
}

function getString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
