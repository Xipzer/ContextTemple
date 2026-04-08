import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "../db.ts";
import { rememberEpisode } from "../episodic.ts";
import { recordObservation } from "../behavioral.ts";
import { runPostSessionHook, runConsolidationAndInstructionsUpdate } from "./hooks.ts";

const homes: string[] = [];
const fixturesDir = path.resolve(import.meta.dir, "../../fixtures/transcripts");

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("post-session hooks", () => {
  test("ingests a session transcript and updates agent instructions", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-hooks-"));
    homes.push(home);

    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) throw temple;

    const instructionsPath = path.join(home, "CLAUDE.md");
    const result = await runPostSessionHook({
      temple,
      sessionId: "test-session-1",
      sessionMarkdownPath: path.join(fixturesDir, "extraction-session.txt"),
      project: "demo",
      instructionsOutputPath: instructionsPath,
      instructionsFormat: "claude-md",
    });
    if (result instanceof Error) throw result;

    expect(result.ingested).toBe(true);
    expect(result.consolidated).toBe(true);
    expect(result.instructionsUpdated).toBe(true);

    const instructionsContent = await fs.readFile(instructionsPath, "utf8");
    expect(instructionsContent).toContain("ContextTemple Memory Layer");
    expect(instructionsContent).toContain("Tool-Calling Policy");

    await temple.close();
  });

  test("consolidates and regenerates instructions on demand", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-consolidate-hooks-"));
    homes.push(home);

    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) throw temple;

    const obs = await recordObservation({
      temple,
      input: { project: "demo", dimension: "guard", statement: "Always run tests before pushing." },
    });
    if (obs instanceof Error) throw obs;

    const instructionsPath = path.join(home, "AGENTS.md");
    const result = await runConsolidationAndInstructionsUpdate({
      temple,
      project: "demo",
      instructionsOutputPath: instructionsPath,
      instructionsFormat: "agents-md",
    });
    if (result instanceof Error) throw result;

    expect(result.consolidated).toBe(true);
    expect(result.instructionsUpdated).toBe(true);

    const instructionsContent = await fs.readFile(instructionsPath, "utf8");
    expect(instructionsContent).toContain("Always run tests before pushing");

    await temple.close();
  });
});
