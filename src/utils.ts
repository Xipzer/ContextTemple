import * as errore from "errore";

import { JsonEncodingError, JsonParsingError } from "./errors.ts";

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function parseJsonStringArray({
  value,
  context,
}: {
  value: string;
  context: string;
}) {
  const parsed = errore.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => new JsonParsingError({ context, cause }),
  });

  if (parsed instanceof Error) {
    console.warn(parsed.message);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(`Stored JSON for ${context} was not an array`);
    return [];
  }

  return parsed.filter((item): item is string => typeof item === "string");
}

export function parseJsonNumberArray({
  value,
  context,
}: {
  value: string;
  context: string;
}) {
  const parsed = errore.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => new JsonParsingError({ context, cause }),
  });

  if (parsed instanceof Error) {
    console.warn(parsed.message);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(`Stored JSON for ${context} was not an array`);
    return [];
  }

  return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

export function stringifyJson({
  value,
  context,
}: {
  value: unknown;
  context: string;
}) {
  const encoded = errore.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new JsonEncodingError({ context, cause }),
  });

  return encoded;
}

export function scoreRecency(createdAt: Date, horizonDays: number) {
  const ageMs = Date.now() - createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / horizonDays);
}
