import fs from "node:fs/promises";
import path from "node:path";

import type { TempleDatabase } from "../db.ts";
import { runConsolidationCycle } from "../consolidation.ts";
import { generateAgentInstructions, type AgentInstructionsFormat } from "./instructions.ts";
import { ingestKimakiSession } from "./session-adapter.ts";
import { FileReadError } from "../errors.ts";

export type PostSessionHookResult = {
  sessionId: string;
  ingested: boolean;
  consolidated: boolean;
  instructionsUpdated: boolean;
  instructionsPath: string | null;
};

export async function runPostSessionHook({
  temple,
  sessionId,
  sessionMarkdownPath,
  project,
  instructionsOutputPath,
  instructionsFormat = "claude-md",
  autoPromote = true,
}: {
  temple: TempleDatabase;
  sessionId: string;
  sessionMarkdownPath: string;
  project?: string | null;
  instructionsOutputPath?: string | null;
  instructionsFormat?: AgentInstructionsFormat;
  autoPromote?: boolean;
}) {
  const ingestionResult = await ingestKimakiSession({
    temple,
    sessionId,
    project,
    sessionMarkdownPath,
    autoPromote,
    autoConsolidate: true,
  });
  if (ingestionResult instanceof Error) return ingestionResult;

  const ingested = !ingestionResult.skipped;
  const consolidated = ingestionResult.consolidated;
  let instructionsUpdated = false;
  let instructionsPath: string | null = null;

  if (instructionsOutputPath && ingested) {
    const instructions = await generateAgentInstructions({
      temple,
      project,
      format: instructionsFormat,
    });
    if (instructions instanceof Error) return instructions;

    const absoluteOutputPath = path.resolve(instructionsOutputPath);
    const parentDir = path.dirname(absoluteOutputPath);
    const mkdirResult = await fs.mkdir(parentDir, { recursive: true }).catch(
      (cause) => new FileReadError({ path: parentDir, cause }),
    );
    if (mkdirResult instanceof Error) return mkdirResult;

    const writeResult = await fs.writeFile(absoluteOutputPath, instructions.markdown, "utf8").catch(
      (cause) => new FileReadError({ path: absoluteOutputPath, cause }),
    );
    if (writeResult instanceof Error) return writeResult;

    instructionsUpdated = true;
    instructionsPath = absoluteOutputPath;
  }

  return {
    sessionId,
    ingested,
    consolidated,
    instructionsUpdated,
    instructionsPath,
  } satisfies PostSessionHookResult;
}

export async function runConsolidationAndInstructionsUpdate({
  temple,
  project,
  instructionsOutputPath,
  instructionsFormat = "claude-md",
}: {
  temple: TempleDatabase;
  project?: string | null;
  instructionsOutputPath: string;
  instructionsFormat?: AgentInstructionsFormat;
}) {
  const consolidation = await runConsolidationCycle({ temple, project });
  if (consolidation instanceof Error) return consolidation;

  const instructions = await generateAgentInstructions({
    temple,
    project,
    format: instructionsFormat,
  });
  if (instructions instanceof Error) return instructions;

  const absoluteOutputPath = path.resolve(instructionsOutputPath);
  const parentDir = path.dirname(absoluteOutputPath);
  const mkdirResult = await fs.mkdir(parentDir, { recursive: true }).catch(
    (cause) => new FileReadError({ path: parentDir, cause }),
  );
  if (mkdirResult instanceof Error) return mkdirResult;

  const writeResult = await fs.writeFile(absoluteOutputPath, instructions.markdown, "utf8").catch(
    (cause) => new FileReadError({ path: absoluteOutputPath, cause }),
  );
  if (writeResult instanceof Error) return writeResult;

  return {
    consolidated: true,
    instructionsUpdated: true,
    instructionsPath: absoluteOutputPath,
    ruleCount: instructions.ruleCount,
    memoryCount: instructions.memoryCount,
  };
}
