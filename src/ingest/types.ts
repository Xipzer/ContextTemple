export const transcriptStoredFormats = ["jsonl", "chat-json", "prefixed-text"] as const;
export const transcriptRequestedFormats = ["auto", ...transcriptStoredFormats] as const;
export const transcriptActors = ["system", "user", "assistant", "tool"] as const;
export const transcriptEventTypes = ["message", "tool_use", "tool_result", "note"] as const;

export type TranscriptFormat = (typeof transcriptStoredFormats)[number];
export type TranscriptRequestedFormat = (typeof transcriptRequestedFormats)[number];
export type TranscriptActor = (typeof transcriptActors)[number];
export type TranscriptEventType = (typeof transcriptEventTypes)[number];

export type CanonicalTranscriptEvent = {
  eventIndex: number;
  actor: TranscriptActor;
  eventType: TranscriptEventType;
  name: string | null;
  content: string;
  occurredAt: Date | null;
  metadata: Record<string, unknown>;
};

export type ParsedTranscript = {
  format: TranscriptFormat;
  events: CanonicalTranscriptEvent[];
  startedAt: Date | null;
  endedAt: Date | null;
  warnings: string[];
};

export type ParsedTranscriptFile = ParsedTranscript & {
  checksum: string;
  sourcePath: string;
};

export type StoredTranscript = {
  id: string;
  project: string | null;
  sourcePath: string;
  sourceLabel: string | null;
  format: TranscriptFormat;
  checksum: string;
  eventCount: number;
  importedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
};

export type StoredTranscriptEvent = CanonicalTranscriptEvent & {
  id: string;
  transcriptId: string;
};

export type TranscriptImportResult = {
  duplicate: boolean;
  transcript: StoredTranscript;
  eventsInserted: number;
  warnings: string[];
};
