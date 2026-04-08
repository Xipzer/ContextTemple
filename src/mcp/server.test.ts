import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { contextTempleMcpTools, executeContextTempleMcpTool } from "./server.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("mcp server", () => {
  test("exposes the core ContextTemple tool surface", () => {
    const toolNames = contextTempleMcpTools.map((tool) => tool.name);
    expect(toolNames).toContain("contexttemple_status");
    expect(toolNames).toContain("contexttemple_search_memory");
    expect(toolNames).toContain("contexttemple_startup_context");
    expect(toolNames).toContain("contexttemple_runtime_plan");
    expect(toolNames).toContain("contexttemple_import_transcript");
  });

  test("executes MCP tools against a real local store", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-mcp-"));
    homes.push(home);

    const imported = await executeContextTempleMcpTool({
      name: "contexttemple_import_transcript",
      args: {
        homeDir: home,
        filePath: path.join(fixturesDir, "extraction-session.txt"),
        project: "demo",
      },
    });
    if (imported instanceof Error) throw imported;
    const transcriptId = "transcript" in imported ? imported.transcript.id : null;
    expect(transcriptId).toBeTruthy();

    const extracted = await executeContextTempleMcpTool({
      name: "contexttemple_extract_transcript",
      args: { homeDir: home, transcriptId },
    });
    if (extracted instanceof Error) throw extracted;
    const extractionRunId = "run" in extracted ? extracted.run.id : null;
    expect(extractionRunId).toBeTruthy();

    const promoted = await executeContextTempleMcpTool({
      name: "contexttemple_promote_extraction",
      args: { homeDir: home, extractionRunId },
    });
    if (promoted instanceof Error) throw promoted;

    const plan = await executeContextTempleMcpTool({
      name: "contexttemple_runtime_plan",
      args: {
        homeDir: home,
        project: "demo",
        messages: [{ role: "user", content: "What auth flow did we choose?" }],
      },
    });
    if (plan instanceof Error) throw plan;
    expect("retrievedMemories" in plan && plan.retrievedMemories.length).toBeGreaterThan(0);
  });
});
