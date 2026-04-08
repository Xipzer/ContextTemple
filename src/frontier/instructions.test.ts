import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase } from "../db.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";
import { generateAgentInstructions } from "./instructions.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("agent instructions generator", () => {
  test("generates CLAUDE.md-compatible instructions with rules, memories, and tool-calling policy", async () => {
    const temple = await seededTemple();

    const instructions = await generateAgentInstructions({ temple, project: "demo", format: "claude-md" });
    if (instructions instanceof Error) throw instructions;

    expect(instructions.markdown).toContain("ContextTemple Memory Layer");
    expect(instructions.markdown).toContain("Behavioral Memory");
    expect(instructions.markdown).toContain("Tool-Calling Policy");
    expect(instructions.markdown).toContain("contexttemple_startup_context");
    expect(instructions.markdown).toContain("contexttemple_search_memory");
    expect(instructions.markdown).toContain("contexttemple_record_observation");
    expect(instructions.markdown).toContain("contexttemple_runtime_complete");
    expect(instructions.ruleCount).toBeGreaterThan(0);

    await temple.close();
  });

  test("generates AGENTS.md-compatible instructions", async () => {
    const temple = await seededTemple();

    const instructions = await generateAgentInstructions({ temple, project: "demo", format: "agents-md" });
    if (instructions instanceof Error) throw instructions;

    expect(instructions.markdown).toContain("Agent Memory Instructions");
    expect(instructions.markdown).toContain("Tool-Calling Policy");

    await temple.close();
  });
});

async function seededTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-instructions-"));
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
