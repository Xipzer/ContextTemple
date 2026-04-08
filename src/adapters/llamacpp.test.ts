import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { createLlamaCppBridgeApp } from "./llamacpp.ts";
import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase } from "../db.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";

const homes: string[] = [];
const servers: Array<{ stop: (close?: boolean) => void }> = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("llama.cpp bridge", () => {
  test("injects ContextTemple planning and forwards a non-streaming chat completion", async () => {
    const temple = await seededTemple();

    const upstream = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { messages: Array<{ role: string; content: string }> };
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: `Echoed ${body.messages.at(-1)?.content}`,
              },
            },
          ],
        });
      },
    });
    servers.push(upstream);

    const app = createLlamaCppBridgeApp({
      temple,
      llamaCppUrl: `http://127.0.0.1:${upstream.port}`,
      defaultProject: "demo",
    });
    const bridge = Bun.serve({ port: 0, fetch: app.fetch });
    servers.push(bridge);

    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemma",
        stream: false,
        messages: [{ role: "user", content: "What auth flow did we choose?" }],
      }),
    });

    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }>; contextTemple: { retrievedMemoryCount: number } };
    expect(response.status).toBe(200);
    expect(payload.choices[0]?.message.content).toContain("What auth flow did we choose?");
    expect(payload.contextTemple.retrievedMemoryCount).toBeGreaterThan(0);

    await temple.close();
  });

  test("streams llama.cpp responses through the bridge", async () => {
    const temple = await seededTemple();

    const upstream = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
            'data: [DONE]\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    servers.push(upstream);

    const app = createLlamaCppBridgeApp({
      temple,
      llamaCppUrl: `http://127.0.0.1:${upstream.port}`,
      defaultProject: "demo",
    });
    const bridge = Bun.serve({ port: 0, fetch: app.fetch });
    servers.push(bridge);

    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemma",
        stream: true,
        messages: [{ role: "user", content: "Give me the auth update." }],
      }),
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("Hello ");
    expect(text).toContain("world");

    await temple.close();
  });
});

async function seededTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-bridge-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;

  const imported = await importTranscript({
    temple,
    filePath: path.join(fixturesDir, "extraction-session.txt"),
    project: "demo",
  });
  if (imported instanceof Error) throw imported;

  const extraction = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
  if (extraction instanceof Error) throw extraction;

  const promotion = await promoteExtractionRun({ temple, extractionRunId: extraction.run.id });
  if (promotion instanceof Error) throw promotion;

  const consolidation = await runConsolidationCycle({ temple, project: "demo" });
  if (consolidation instanceof Error) throw consolidation;

  return temple;
}
