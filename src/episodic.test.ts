import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "./db.ts";
import { recordRetrievalFeedback, rememberEpisode, searchEpisodes } from "./episodic.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("episodic retrieval", () => {
  test("returns the most relevant memory and adjusts salience from feedback", async () => {
    const temple = await createTemple();

    const authMemory = await rememberEpisode({
      temple,
      input: {
        project: "core",
        content: "We decided to migrate authentication to OAuth device flow and keep refresh tokens server-side.",
        tags: ["auth", "oauth"],
      },
    });
    if (authMemory instanceof Error) throw authMemory;

    const styleMemory = await rememberEpisode({
      temple,
      input: {
        project: "core",
        content: "The new landing page uses a dark graphite background with emerald highlights.",
        tags: ["design"],
      },
    });
    if (styleMemory instanceof Error) throw styleMemory;

    const results = await searchEpisodes({ temple, query: "oauth auth migration", project: "core", limit: 2 });
    if (results instanceof Error) throw results;

    expect(results[0]?.id).toBe(authMemory.id);

    const feedback = await recordRetrievalFeedback({
      temple,
      retrievalId: results[0]!.retrievalId,
      accepted: true,
    });
    if (feedback instanceof Error) throw feedback;

    expect(feedback.salience).toBeGreaterThan(authMemory.salience);

    await temple.close();
  });

  test("finds relevant memories through semantic expansion and reranking", async () => {
    const temple = await createTemple();

    const authMemory = await rememberEpisode({
      temple,
      input: {
        project: "core",
        content: "We decided to migrate authentication to OAuth device flow and keep refresh tokens server-side.",
        tags: ["auth", "oauth"],
      },
    });
    if (authMemory instanceof Error) throw authMemory;

    const infraMemory = await rememberEpisode({
      temple,
      input: {
        project: "core",
        content: "The deployment server now runs on a graphite themed dashboard with emerald health checks.",
        tags: ["infra"],
      },
    });
    if (infraMemory instanceof Error) throw infraMemory;

    const results = await searchEpisodes({
      temple,
      query: "login approval polling with device code",
      project: "core",
      limit: 2,
    });
    if (results instanceof Error) throw results;

    expect(results[0]?.id).toBe(authMemory.id);
    expect(results[0]?.scoreBreakdown.semantic).toBeGreaterThan(0);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-episodic-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
