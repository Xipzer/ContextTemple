import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "../db.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { extractTranscriptCandidates, listExtractionCandidates, listExtractionRuns } from "./candidates.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("transcript extraction", () => {
  test("extracts observations, decisions, facts, and outcomes from a transcript", async () => {
    const temple = await createTemple();
    const imported = await importTranscript({
      temple,
      filePath: path.join(fixturesDir, "extraction-session.txt"),
      project: "demo",
    });
    if (imported instanceof Error) throw imported;

    const result = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
    if (result instanceof Error) throw result;

    expect(result.duplicate).toBe(false);
    expect(result.candidates.some((candidate) => candidate.candidateType === "decision")).toBe(true);
    expect(result.candidates.some((candidate) => candidate.candidateType === "fact")).toBe(true);
    expect(result.candidates.some((candidate) => candidate.candidateType === "outcome")).toBe(true);
    expect(
      result.candidates.some(
        (candidate) => candidate.candidateType === "observation" && candidate.behavioralDimension === "guard",
      ),
    ).toBe(true);
    expect(
      result.candidates.some(
        (candidate) => candidate.candidateType === "observation" && candidate.behavioralDimension === "style",
      ),
    ).toBe(true);

    const runs = await listExtractionRuns({ temple, transcriptId: imported.transcript.id });
    if (runs instanceof Error) throw runs;
    expect(runs.length).toBe(1);
    expect(runs[0]?.candidateCount).toBe(result.candidates.length);

    const candidates = await listExtractionCandidates({ temple, transcriptId: imported.transcript.id });
    if (candidates instanceof Error) throw candidates;
    expect(candidates.length).toBe(result.candidates.length);

    await temple.close();
  });

  test("re-running extraction is idempotent for the same transcript and engine version", async () => {
    const temple = await createTemple();
    const imported = await importTranscript({
      temple,
      filePath: path.join(fixturesDir, "extraction-session.txt"),
      project: "demo",
    });
    if (imported instanceof Error) throw imported;

    const firstRun = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
    if (firstRun instanceof Error) throw firstRun;

    const secondRun = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
    if (secondRun instanceof Error) throw secondRun;

    expect(secondRun.duplicate).toBe(true);
    expect(secondRun.run.id).toBe(firstRun.run.id);
    expect(secondRun.candidates.length).toBe(firstRun.candidates.length);

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-extract-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
