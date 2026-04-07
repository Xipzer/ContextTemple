import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { consolidateBehavioralMemory, listActiveRules, recordObservation } from "./behavioral.ts";
import { openTempleDatabase } from "./db.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("behavioral consolidation", () => {
  test("promotes repeated project observations to a global rule", async () => {
    const temple = await createTemple();

    const first = await recordObservation({
      temple,
      input: {
        project: "alpha",
        dimension: "guard",
        statement: "Always read the target file before editing it",
      },
    });
    if (first instanceof Error) throw first;

    const second = await recordObservation({
      temple,
      input: {
        project: "beta",
        dimension: "guard",
        statement: "Always read the target file before editing it",
      },
    });
    if (second instanceof Error) throw second;

    const report = await consolidateBehavioralMemory({ temple });
    if (report instanceof Error) throw report;

    expect(report.processedObservations).toBe(2);
    expect(report.promotedRules).toBe(1);

    const rules = await listActiveRules({ temple });
    if (rules instanceof Error) throw rules;

    const promoted = rules.find(
      (rule) => rule.scope === "global" && rule.statement === "Always read the target file before editing it",
    );
    expect(promoted).toBeDefined();

    await temple.close();
  });
});

async function createTemple() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-behavioral-"));
  homes.push(home);

  const temple = await openTempleDatabase({ homeDir: home });
  if (temple instanceof Error) throw temple;
  return temple;
}
