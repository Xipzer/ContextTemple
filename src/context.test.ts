import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { recordObservation } from "./behavioral.ts";
import { runConsolidationCycle } from "./consolidation.ts";
import { buildStartupContext } from "./context.ts";
import { openTempleDatabase } from "./db.ts";
import { rememberEpisode } from "./episodic.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("startup context", () => {
  test("merges behavioral rules and episodic memory into one startup payload", async () => {
    const temple = await createTemple();

    const observation = await recordObservation({
      temple,
      input: {
        project: "core",
        dimension: "workflow",
        statement: "Run the relevant checks before claiming a task is finished",
      },
    });
    if (observation instanceof Error) throw observation;

    const consolidation = await runConsolidationCycle({ temple });
    if (consolidation instanceof Error) throw consolidation;

    const memory = await rememberEpisode({
      temple,
      input: {
        project: "core",
        source: "session-1",
        content: "The auth migration depends on issuing device codes and polling for approval every five seconds.",
        tags: ["auth", "device-code"],
      },
    });
    if (memory instanceof Error) throw memory;

    const context = await buildStartupContext({ temple, project: "core", query: "auth device flow" });
    if (context instanceof Error) throw context;

    expect(context.markdown).toContain("Run the relevant checks before claiming a task is finished");
    expect(context.markdown).toContain("auth migration depends on issuing device codes");
    expect(context.rules.length).toBeGreaterThan(0);
    expect(context.memories.length).toBeGreaterThan(0);

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-context-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
