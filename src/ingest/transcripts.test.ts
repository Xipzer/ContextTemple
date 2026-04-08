import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "../db.ts";
import { listTranscriptEvents, importTranscript, parseTranscriptFile } from "./transcripts.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("transcript ingestion", () => {
  test("auto-detects JSONL transcripts into canonical events", async () => {
    const parsed = await parseTranscriptFile({
      filePath: path.join(fixturesDir, "jsonl-session.jsonl"),
    });
    if (parsed instanceof Error) throw parsed;

    expect(parsed.format).toBe("jsonl");
    expect(parsed.events.length).toBe(6);
    expect(parsed.events[3]?.eventType).toBe("tool_use");
    expect(parsed.events[4]?.eventType).toBe("tool_result");
  });

  test("auto-detects chat JSON transcripts", async () => {
    const parsed = await parseTranscriptFile({
      filePath: path.join(fixturesDir, "chat-export.json"),
    });
    if (parsed instanceof Error) throw parsed;

    expect(parsed.format).toBe("chat-json");
    expect(parsed.events.length).toBe(3);
    expect(parsed.events[1]?.actor).toBe("user");
  });

  test("imports transcripts idempotently and persists canonical events", async () => {
    const temple = await createTemple();
    const filePath = path.join(fixturesDir, "prefixed-chat.txt");

    const firstImport = await importTranscript({ temple, filePath, project: "demo" });
    if (firstImport instanceof Error) throw firstImport;

    expect(firstImport.duplicate).toBe(false);
    expect(firstImport.eventsInserted).toBeGreaterThan(0);

    const secondImport = await importTranscript({ temple, filePath, project: "demo" });
    if (secondImport instanceof Error) throw secondImport;

    expect(secondImport.duplicate).toBe(true);
    expect(secondImport.transcript.id).toBe(firstImport.transcript.id);

    const events = await listTranscriptEvents({ temple, transcriptId: firstImport.transcript.id });
    if (events instanceof Error) throw events;

    expect(events.length).toBe(6);
    expect(events[3]?.name).toBe("read");
    expect(events[4]?.content).toContain("shipping embeddings after transcript ingestion");

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-transcripts-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
