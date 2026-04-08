import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "bun:test";

import { openTempleDatabase } from "../db.ts";
import { rememberEpisode } from "../episodic.ts";
import { exportTempleSnapshot, importTempleSnapshot, purgeProjectData } from "./snapshot.ts";
import { getTempleStatus } from "../status.ts";

const pathsToDelete: string[] = [];

afterEach(async () => {
  await Promise.all(pathsToDelete.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe("snapshot maintenance", () => {
  test("exports and restores the temple SQLite store", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-snapshot-home-"));
    const restoreHome = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-snapshot-restore-"));
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-snapshot-backup-"));
    const backupPath = path.join(backupDir, "backup.db");
    pathsToDelete.push(home, restoreHome, backupDir);

    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) throw temple;

    const memory = await rememberEpisode({
      temple,
      input: { project: "demo", content: "We decided to use OAuth device flow.", tags: ["auth"] },
    });
    if (memory instanceof Error) throw memory;

    const exported = await exportTempleSnapshot({ temple, outputPath: backupPath });
    if (exported instanceof Error) throw exported;

    const imported = await importTempleSnapshot({ homeDir: restoreHome, snapshotPath: backupPath });
    if (imported instanceof Error) throw imported;

    const restored = await openTempleDatabase({ homeDir: restoreHome });
    if (restored instanceof Error) throw restored;
    const status = await getTempleStatus({ temple: restored });
    await restored.close();
    if (status instanceof Error) throw status;

    expect(status.episodicMemories).toBeGreaterThan(0);
  });

  test("purges project-scoped data", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-purge-home-"));
    pathsToDelete.push(home);

    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) throw temple;

    const demoMemory = await rememberEpisode({
      temple,
      input: { project: "demo", content: "We decided to use OAuth device flow.", tags: ["auth"] },
    });
    if (demoMemory instanceof Error) throw demoMemory;

    const otherMemory = await rememberEpisode({
      temple,
      input: { project: "other", content: "Keep responses terse.", tags: ["style"] },
    });
    if (otherMemory instanceof Error) throw otherMemory;

    const purged = await purgeProjectData({ temple, project: "demo" });
    if (purged instanceof Error) throw purged;

    const status = await getTempleStatus({ temple });
    await temple.close();
    if (status instanceof Error) throw status;

    expect(purged.episodicMemories).toBeGreaterThan(0);
    expect(status.episodicMemories).toBe(1);
  });
});
