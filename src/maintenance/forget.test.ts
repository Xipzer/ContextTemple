import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "../db.ts";
import { rememberEpisode } from "../episodic.ts";
import { runActiveForgetting } from "./forget.ts";
import { episodicMemories } from "../schema.ts";
import { eq } from "drizzle-orm";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("active forgetting", () => {
  test("archives low-value old memories", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-forget-"));
    homes.push(home);

    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) throw temple;

    const memory = await rememberEpisode({
      temple,
      input: { project: "demo", content: "Temporary low-value note.", tags: ["temp"] },
    });
    if (memory instanceof Error) throw memory;

    const degrade = await temple.db
      .update(episodicMemories)
      .set({
        usefulnessScore: 0.1,
        negativeFeedbackCount: 4,
        positiveFeedbackCount: 0,
        accessCount: 0,
        updatedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      })
      .where(eq(episodicMemories.id, memory.id));
    if (degrade instanceof Error) throw degrade;

    const result = await runActiveForgetting({ temple, project: "demo", usefulnessThreshold: 0.2, maxAgeDays: 90 });
    if (result instanceof Error) throw result;
    expect(result.archivedMemoryIds).toContain(memory.id);

    const rows = await temple.db.select().from(episodicMemories).where(eq(episodicMemories.id, memory.id));
    expect(rows[0]?.status).toBe("archived");

    await temple.close();
  });
});
