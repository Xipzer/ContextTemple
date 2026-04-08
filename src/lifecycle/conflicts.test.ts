import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { recordObservation, listActiveRules } from "../behavioral.ts";
import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase } from "../db.ts";
import { rememberEpisode, searchEpisodes } from "../episodic.ts";
import { listMemoryConflictRecords, listRuleConflictRecords, resolveRuleConflict } from "./conflicts.ts";
import { episodicMemories } from "../schema.ts";
import { eq } from "drizzle-orm";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("lifecycle conflicts", () => {
  test("detects contradictory behavioral rules and hides them from active context", async () => {
    const temple = await createTemple();

    const first = await recordObservation({
      temple,
      input: { project: "demo", dimension: "style", statement: "Keep responses terse and concise." },
    });
    if (first instanceof Error) throw first;

    const second = await recordObservation({
      temple,
      input: { project: "demo", dimension: "style", statement: "Provide verbose and detailed explanations." },
    });
    if (second instanceof Error) throw second;

    const report = await runConsolidationCycle({ temple, project: "demo" });
    if (report instanceof Error) throw report;

    expect(report.conflictedRules).toBeGreaterThan(0);

    const conflicts = await listRuleConflictRecords({ temple });
    if (conflicts instanceof Error) throw conflicts;
    expect(conflicts.some((conflict) => conflict.status === "open")).toBe(true);

    const activeRules = await listActiveRules({ temple, project: "demo" });
    if (activeRules instanceof Error) throw activeRules;
    expect(activeRules.length).toBe(0);

    await temple.close();
  });

  test("supersedes old episodic memories when a newer replacement arrives from the same source", async () => {
    const temple = await createTemple();

    const older = await rememberEpisode({
      temple,
      input: {
        project: "demo",
        source: "runtime:session:user",
        content: "Auth now uses OAuth device flow.",
        tags: ["auth"],
      },
    });
    if (older instanceof Error) throw older;

    const newer = await rememberEpisode({
      temple,
      input: {
        project: "demo",
        source: "runtime:session:user",
        content: "Auth no longer uses OAuth device flow, instead use authorization code flow.",
        tags: ["auth"],
      },
    });
    if (newer instanceof Error) throw newer;

    const olderRows = await temple.db.select().from(episodicMemories).where(eq(episodicMemories.id, older.id));
    const newerRows = await temple.db.select().from(episodicMemories).where(eq(episodicMemories.id, newer.id));
    const olderRow = olderRows[0];
    const newerRow = newerRows[0];
    if (!olderRow || !newerRow) throw new Error("expected persisted episodic memories");

    expect(olderRow.status).toBe("superseded");
    expect(olderRow.supersededByMemoryId).toBe(newer.id);
    expect(newerRow.status).toBe("active");

    const results = await searchEpisodes({ temple, query: "authorization code flow", project: "demo", limit: 5 });
    if (results instanceof Error) throw results;
    expect(results[0]?.id).toBe(newer.id);

    const memoryConflicts = await listMemoryConflictRecords({ temple });
    if (memoryConflicts instanceof Error) throw memoryConflicts;
    expect(memoryConflicts.length).toBe(0);

    await temple.close();
  });

  test("resolves rule conflicts through the operator flow", async () => {
    const temple = await createTemple();

    const first = await recordObservation({ temple, input: { project: "demo", dimension: "style", statement: "Keep responses terse." } });
    if (first instanceof Error) throw first;
    const second = await recordObservation({ temple, input: { project: "demo", dimension: "style", statement: "Provide verbose responses." } });
    if (second instanceof Error) throw second;

    const consolidation = await runConsolidationCycle({ temple, project: "demo" });
    if (consolidation instanceof Error) throw consolidation;

    const conflicts = await listRuleConflictRecords({ temple });
    if (conflicts instanceof Error) throw conflicts;
    const conflict = conflicts.find((item) => item.status === "open");
    if (!conflict) throw new Error("expected open rule conflict");

    const resolution = await resolveRuleConflict({ temple, conflictId: conflict.id, winner: "left", note: "Prefer terse mode" });
    if (resolution instanceof Error) throw resolution;

    const activeRules = await listActiveRules({ temple, project: "demo" });
    if (activeRules instanceof Error) throw activeRules;
    expect(activeRules.length).toBe(1);

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-lifecycle-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
