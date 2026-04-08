import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { listActiveRules } from "../behavioral.ts";
import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase } from "../db.ts";
import { searchEpisodes } from "../episodic.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { listPromotionRuns, promoteExtractionRun } from "./candidates.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("candidate promotion", () => {
  test("promotes extracted observations and episodic memories", async () => {
    const temple = await createTemple();
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

    expect(promotion.duplicate).toBe(false);
    expect(promotion.promotedObservationIds.length).toBe(2);
    expect(promotion.promotedMemoryIds.length).toBe(3);

    const searchResults = await searchEpisodes({ temple, query: "oauth device flow", project: "demo" });
    if (searchResults instanceof Error) throw searchResults;
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0]?.summary).toContain("OAuth device flow");

    const consolidation = await runConsolidationCycle({ temple, project: "demo" });
    if (consolidation instanceof Error) throw consolidation;

    const rules = await listActiveRules({ temple, project: "demo" });
    if (rules instanceof Error) throw rules;
    expect(rules.some((rule) => rule.statement.includes("Always read the target file"))).toBe(true);
    expect(rules.some((rule) => rule.statement.includes("Keep responses terse"))).toBe(true);

    const runs = await listPromotionRuns({ temple, extractionRunId: extraction.run.id });
    if (runs instanceof Error) throw runs;
    expect(runs.length).toBe(1);

    await temple.close();
  });

  test("promotion is idempotent for the same extraction run and policy version", async () => {
    const temple = await createTemple();
    const imported = await importTranscript({
      temple,
      filePath: path.join(fixturesDir, "extraction-session.txt"),
      project: "demo",
    });
    if (imported instanceof Error) throw imported;

    const extraction = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
    if (extraction instanceof Error) throw extraction;

    const firstPromotion = await promoteExtractionRun({ temple, extractionRunId: extraction.run.id });
    if (firstPromotion instanceof Error) throw firstPromotion;

    const secondPromotion = await promoteExtractionRun({ temple, extractionRunId: extraction.run.id });
    if (secondPromotion instanceof Error) throw secondPromotion;

    expect(secondPromotion.duplicate).toBe(true);
    expect(secondPromotion.run.id).toBe(firstPromotion.run.id);
    expect(secondPromotion.promotedObservationIds).toEqual(firstPromotion.promotedObservationIds);
    expect(secondPromotion.promotedMemoryIds).toEqual(firstPromotion.promotedMemoryIds);

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-promote-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
