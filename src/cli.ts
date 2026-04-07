#!/usr/bin/env bun

import process from "node:process";
import { createRequire } from "node:module";

import { goke } from "goke";
import { z } from "zod";

import { recordObservation } from "./behavioral.ts";
import { buildStartupContext } from "./context.ts";
import { openTempleDatabase } from "./db.ts";
import { rememberEpisode, searchEpisodes } from "./episodic.ts";
import { startTempleServer } from "./http.ts";
import { getTempleStatus } from "./status.ts";
import { behavioralDimensions } from "./types.ts";
import { runConsolidationCycle } from "./consolidation.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const cli = goke("contexttemple");

cli
  .option(
    "--home [path]",
    z.string().describe("Override the default ContextTemple home directory. By default the local store lives in ~/.contexttemple."),
  )
  .option("--json", "Print structured JSON instead of human-readable output.");

cli
  .command("", "Show the available ContextTemple commands")
  .action(() => {
    cli.outputHelp();
  });

cli
  .command(
    "init",
    "Initialize the local ContextTemple store and create the SQLite database if it does not already exist.",
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const status = await getTempleStatus({ temple });
    await temple.close();
    if (status instanceof Error) return printError(status);

    return printOutput({
      json: options.json,
      human: `Initialized ContextTemple at ${temple.paths.homeDir}`,
      value: { homeDir: temple.paths.homeDir, dbPath: temple.paths.dbPath, status },
    });
  });

cli
  .command(
    "remember",
    "Store an episodic memory that can be retrieved later during runtime recall.",
  )
  .option(
    "--content <content>",
    z.string().describe("Raw content to store. This should capture a fact, decision, artifact, or relevant session note."),
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope. Retrieval can later be narrowed to this project."),
  )
  .option(
    "--source [source]",
    z.string().describe("Optional source identifier such as a file path, transcript id, or external reference."),
  )
  .option(
    "--tag <tag>",
    z.array(z.string()).describe("Tags attached to the memory. Repeat the flag to add more than one tag."),
  )
  .option(
    "--salience [salience]",
    z.number().default(5).describe("Salience from 1 to 10. Higher salience makes the memory rank higher before feedback is collected."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const memory = await rememberEpisode({
      temple,
      input: {
        content: options.content,
        project: options.project,
        source: options.source,
        tags: options.tag,
        salience: options.salience,
      },
    });
    await temple.close();
    if (memory instanceof Error) return printError(memory);

    return printOutput({
      json: options.json,
      human: `Stored episodic memory ${memory.id}`,
      value: memory,
    });
  });

cli
  .command(
    "observe",
    "Record a behavioral signal such as a correction, preference, workflow expectation, or failure pattern.",
  )
  .option(
    "--statement <statement>",
    z.string().describe("The normalized behavioral observation to store, for example: Always read the file before editing it."),
  )
  .option(
    "--dimension <dimension>",
    z.enum(behavioralDimensions).describe("Behavioral dimension for the observation."),
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope. Cross-project repetition later promotes compatible rules to global."),
  )
  .option(
    "--evidence [evidence]",
    z.string().describe("Optional raw evidence or short rationale that explains why the observation matters."),
  )
  .option(
    "--confidence [confidence]",
    z.number().default(0.7).describe("Confidence from 0.1 to 1.0. Repeated observations reinforce weight during consolidation."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const observation = await recordObservation({
      temple,
      input: {
        statement: options.statement,
        dimension: options.dimension,
        project: options.project,
        evidence: options.evidence,
        confidence: options.confidence,
      },
    });
    await temple.close();
    if (observation instanceof Error) return printError(observation);

    return printOutput({
      json: options.json,
      human: `Recorded observation ${observation.id}`,
      value: observation,
    });
  });

cli
  .command(
    "consolidate",
    "Promote unprocessed behavioral observations into durable rules and global guards.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope. When omitted, ContextTemple consolidates every pending observation."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const report = await runConsolidationCycle({ temple, project: options.project });
    await temple.close();
    if (report instanceof Error) return printError(report);

    return printOutput({
      json: options.json,
      human: `Processed ${report.processedObservations} observations and promoted ${report.promotedRules} global rules`,
      value: report,
    });
  });

cli
  .command("search <query>", "Search episodic memory using lexical overlap, salience, and recency.")
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for narrowing the search space."),
  )
  .option(
    "--limit [limit]",
    z.int().default(5).describe("Maximum number of memories to return."),
  )
  .action(async (query, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const results = await searchEpisodes({
      temple,
      query,
      project: options.project,
      limit: options.limit,
    });
    await temple.close();
    if (results instanceof Error) return printError(results);

    return printOutput({
      json: options.json,
      human: results.map((result) => `- ${result.summary} (score=${result.score})`).join("\n") || "No results",
      value: results,
    });
  });

cli
  .command(
    "wake [query]",
    "Generate startup context that combines durable behavioral rules with relevant episodic memory.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope. Behavioral rules and episodic retrieval are both narrowed when set."),
  )
  .option(
    "--rules [rules]",
    z.int().default(8).describe("Maximum number of rules to include in the startup context."),
  )
  .option(
    "--memories [memories]",
    z.int().default(4).describe("Maximum number of episodic memories to include in the startup context."),
  )
  .action(async (query, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const context = await buildStartupContext({
      temple,
      query,
      project: options.project,
      maxRules: options.rules,
      maxMemories: options.memories,
    });
    await temple.close();
    if (context instanceof Error) return printError(context);

    return printOutput({
      json: options.json,
      human: context.markdown,
      value: context,
    });
  });

cli
  .command("status", "Show counts for observations, active rules, episodic memories, and retrieval events.")
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const status = await getTempleStatus({ temple });
    await temple.close();
    if (status instanceof Error) return printError(status);

    return printOutput({
      json: options.json,
      human: [
        `observations: ${status.observations}`,
        `active rules: ${status.activeRules}`,
        `episodic memories: ${status.episodicMemories}`,
        `retrieval events: ${status.retrievalEvents}`,
      ].join("\n"),
      value: status,
    });
  });

cli
  .command("serve", "Start the local Hono API so other tools can read and write ContextTemple memory.")
  .option(
    "--port [port]",
    z.int().default(4000).describe("Port to listen on for the local ContextTemple API server."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const server = startTempleServer({ temple, port: options.port });
    if (server instanceof Error) {
      await temple.close();
      return printError(server);
    }

    process.on("SIGINT", async () => {
      server.server.stop(true);
      await temple.close();
      process.exit(0);
    });

    return printOutput({
      json: options.json,
      human: `ContextTemple listening on http://localhost:${server.server.port}`,
      value: { port: server.server.port },
    });
  });

cli.help();
cli.version(packageJson.version);
cli.parse();

function printOutput({
  json,
  human,
  value,
}: {
  json: boolean | undefined;
  human: string;
  value: unknown;
}) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(human);
}

function printError(error: Error) {
  process.exitCode = 1;
  console.error(error.message);
}
