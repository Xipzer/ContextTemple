import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "../db.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { clusterExtractionCandidates, extractTranscriptCandidates, listExtractionCandidates, reviewExtractionCandidate } from "./candidates.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("extraction review flows", () => {
  test("reviews extracted candidates and clusters pending ones", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-review-"));
    homes.push(home);

    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) throw temple;

    const imported = await importTranscript({ temple, filePath: path.join(fixturesDir, "extraction-session.txt"), project: "demo" });
    if (imported instanceof Error) throw imported;

    const extracted = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
    if (extracted instanceof Error) throw extracted;

    const candidate = extracted.candidates[0];
    if (!candidate) throw new Error("expected extracted candidate");

    const reviewed = await reviewExtractionCandidate({ temple, candidateId: candidate.id, status: "approve", note: "Looks good" });
    if (reviewed instanceof Error) throw reviewed;
    expect(reviewed.reviewStatus).toBe("approved");

    const approved = await listExtractionCandidates({ temple, transcriptId: imported.transcript.id, reviewStatus: "approved" });
    if (approved instanceof Error) throw approved;
    expect(approved.some((item) => item.id === candidate.id)).toBe(true);

    const clusters = await clusterExtractionCandidates({ temple, project: "demo", extractionRunId: extracted.run.id });
    if (clusters instanceof Error) throw clusters;
    expect(clusters.length).toBeGreaterThan(0);

    await temple.close();
  });
});
