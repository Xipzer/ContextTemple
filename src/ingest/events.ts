import type { CanonicalTranscriptEvent, ParsedTranscript } from "./types.ts";

export function finalizeParsedTranscript({
  format,
  events,
  warnings,
}: {
  format: ParsedTranscript["format"];
  events: CanonicalTranscriptEvent[];
  warnings?: string[];
}) {
  const chronologicalEvents = events
    .map((event, eventIndex) => ({ ...event, eventIndex }))
    .filter((event) => event.content.trim().length > 0);
  const occurredTimes = chronologicalEvents.flatMap((event) => (event.occurredAt ? [event.occurredAt.getTime()] : []));

  return {
    format,
    events: chronologicalEvents,
    startedAt: occurredTimes.length > 0 ? new Date(Math.min(...occurredTimes)) : null,
    endedAt: occurredTimes.length > 0 ? new Date(Math.max(...occurredTimes)) : null,
    warnings: warnings ?? [],
  } satisfies ParsedTranscript;
}

export function renderTranscriptEvent(event: CanonicalTranscriptEvent) {
  const actor = event.name ? `${event.actor}(${event.name})` : event.actor;
  return `${String(event.eventIndex + 1).padStart(3, "0")} ${actor} [${event.eventType}] ${event.content}`;
}
