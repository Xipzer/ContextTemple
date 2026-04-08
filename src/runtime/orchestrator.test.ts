import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase } from "../db.ts";
import { searchEpisodes } from "../episodic.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";
import { completeRuntimeTurn, prepareRuntimeTurn } from "./orchestrator.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("runtime orchestrator", () => {
  test("builds startup and retrieval context from seeded memory", async () => {
    const temple = await seededTemple();

    const plan = await prepareRuntimeTurn({
      temple,
      project: "demo",
      messages: [{ role: "user", content: "What auth flow did we choose?" }],
    });
    if (plan instanceof Error) throw plan;

    expect(plan.shouldBootstrap).toBe(true);
    expect(plan.shouldRetrieve).toBe(true);
    expect(plan.retrievedMemories.length).toBeGreaterThan(0);
    expect(plan.systemMessages.join("\n")).toContain("Always read the target file before editing it.");
    expect(plan.systemMessages.join("\n")).toContain("OAuth device flow");

    await temple.close();
  });

  test("writes back runtime observations and episodic outcomes", async () => {
    const temple = await seededTemple();

    const writeback = await completeRuntimeTurn({
      temple,
      project: "demo",
      sessionId: "runtime-test",
      messages: [{ role: "user", content: "Always run checks before saying complete." }],
      assistantMessage: "Implemented the auth update and tests passed.",
    });
    if (writeback instanceof Error) throw writeback;

    expect(writeback.observationsAdded.length).toBeGreaterThan(0);
    expect(writeback.memoriesAdded.length).toBeGreaterThan(0);

    const results = await searchEpisodes({ temple, query: "tests passed auth update", project: "demo" });
    if (results instanceof Error) throw results;
    expect(results.length).toBeGreaterThan(0);

    await temple.close();
  });
});

async function seededTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-runtime-"));
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
