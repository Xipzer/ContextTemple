#!/usr/bin/env bun

import process from "node:process";
import { createRequire } from "node:module";

import { goke } from "goke";
import { z } from "zod";

import { startLlamaCppBridgeServer } from "./adapters/llamacpp.ts";
import { recordObservation } from "./behavioral.ts";
import { buildStartupContext } from "./context.ts";
import { openTempleDatabase } from "./db.ts";
import { rememberEpisode, searchEpisodes } from "./episodic.ts";
import {
  defaultRuntimeBenchmarkPath,
  runBehavioralReplayBenchmark,
  runFirstResponseCalibrationBenchmark,
  runLocalModelUpliftBenchmark,
} from "./evals/replay.ts";
import { defaultRetrievalBenchmarkPath, runRetrievalBenchmark } from "./evals/retrieval.ts";
import { clusterExtractionCandidates, extractTranscriptCandidates, listExtractionCandidates, listExtractionRuns, reviewExtractionCandidate } from "./extract/candidates.ts";
import { startTempleServer } from "./http.ts";
import { renderTranscriptEvent } from "./ingest/events.ts";
import { importTranscript, listTranscriptEvents, listTranscripts, parseTranscriptFile } from "./ingest/transcripts.ts";
import { transcriptRequestedFormats } from "./ingest/types.ts";
import { listMemoryConflictRecords, listRuleConflictRecords, resolveMemoryConflict, resolveRuleConflict } from "./lifecycle/conflicts.ts";
import { runActiveForgetting } from "./maintenance/forget.ts";
import { exportTempleSnapshot, importTempleSnapshot, purgeProjectData } from "./maintenance/snapshot.ts";
import { startContextTempleMcpServer } from "./mcp/server.ts";
import { listPromotionRuns, promoteExtractionRun } from "./promote/candidates.ts";
import { completeRuntimeTurn, prepareRuntimeTurn } from "./runtime/orchestrator.ts";
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
    "transcript ingest <path>",
    "Normalize a transcript into ContextTemple's canonical event schema and optionally persist it for replay and future extraction.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope attached to the imported transcript."),
  )
  .option(
    "--label [label]",
    z.string().describe("Optional friendly source label stored alongside the transcript path."),
  )
  .option(
    "--format [format]",
    z.enum(transcriptRequestedFormats).default("auto").describe("Transcript format to parse. Use auto to let ContextTemple detect the parser."),
  )
  .option(
    "--preview",
    "Parse the transcript and print canonical events without writing anything to the database.",
  )
  .option(
    "--events [events]",
    z.int().default(12).describe("Maximum number of canonical events to print in preview mode."),
  )
  .action(async (path, options) => {
    if (options.preview) {
      const parsed = await parseTranscriptFile({ filePath: path, format: options.format });
      if (parsed instanceof Error) return printError(parsed);

      const previewEvents = parsed.events.slice(0, options.events).map(renderTranscriptEvent).join("\n");
      return printOutput({
        json: options.json,
        human: [
          `format: ${parsed.format}`,
          `checksum: ${parsed.checksum}`,
          `events: ${parsed.events.length}`,
          parsed.warnings.length > 0 ? `warnings: ${parsed.warnings.length}` : "warnings: 0",
          "",
          previewEvents || "No canonical events",
        ].join("\n"),
        value: parsed,
      });
    }

    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const imported = await importTranscript({
      temple,
      filePath: path,
      project: options.project,
      sourceLabel: options.label,
      format: options.format,
    });
    await temple.close();
    if (imported instanceof Error) return printError(imported);

    return printOutput({
      json: options.json,
      human: imported.duplicate
        ? `Transcript already imported as ${imported.transcript.id}`
        : `Imported transcript ${imported.transcript.id} with ${imported.eventsInserted} canonical events`,
      value: imported,
    });
  });

cli
  .command(
    "transcript list",
    "List recently imported transcripts so you can inspect and replay canonical event sources.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for narrowing the transcript list."),
  )
  .option(
    "--limit [limit]",
    z.int().default(20).describe("Maximum number of transcript sources to return."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const transcripts = await listTranscripts({ temple, project: options.project, limit: options.limit });
    await temple.close();
    if (transcripts instanceof Error) return printError(transcripts);

    return printOutput({
      json: options.json,
      human:
        transcripts
          .map((transcript) => `${transcript.id} ${transcript.format} events=${transcript.eventCount} path=${transcript.sourcePath}`)
          .join("\n") || "No imported transcripts",
      value: transcripts,
    });
  });

cli
  .command(
    "transcript events <transcriptId>",
    "Show canonical events for an imported transcript in event order.",
  )
  .option(
    "--limit [limit]",
    z.int().default(100).describe("Maximum number of canonical events to print."),
  )
  .action(async (transcriptId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const events = await listTranscriptEvents({ temple, transcriptId, limit: options.limit });
    await temple.close();
    if (events instanceof Error) return printError(events);

    return printOutput({
      json: options.json,
      human: events.map(renderTranscriptEvent).join("\n") || "No canonical events",
      value: events,
    });
  });

cli
  .command(
    "extract transcript <transcriptId>",
    "Run the heuristic extraction engine against a persisted canonical transcript and store structured candidates.",
  )
  .action(async (transcriptId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await extractTranscriptCandidates({ temple, transcriptId });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: [
        result.duplicate
          ? `Extraction already exists for transcript ${transcriptId}`
          : `Created extraction run ${result.run.id} with ${result.candidates.length} candidates`,
        ...result.candidates.map(
          (candidate) =>
            `- ${candidate.candidateType}${candidate.behavioralDimension ? `/${candidate.behavioralDimension}` : ""}: ${candidate.statement}`,
        ),
      ].join("\n"),
      value: result,
    });
  });

cli
  .command(
    "extract runs",
    "List persisted extraction runs so you can inspect replay state and deduplicate reruns.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for narrowing extraction runs."),
  )
  .option(
    "--transcript [transcriptId]",
    z.string().describe("Optional transcript id for narrowing extraction runs."),
  )
  .option(
    "--limit [limit]",
    z.int().default(20).describe("Maximum number of extraction runs to return."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const runs = await listExtractionRuns({
      temple,
      project: options.project,
      transcriptId: options.transcript,
      limit: options.limit,
    });
    await temple.close();
    if (runs instanceof Error) return printError(runs);

    return printOutput({
      json: options.json,
      human:
        runs
          .map(
            (run) =>
              `${run.id} transcript=${run.transcriptId} engine=${run.engineVersion} candidates=${run.candidateCount}`,
          )
          .join("\n") || "No extraction runs",
      value: runs,
    });
  });

cli
  .command(
    "extract candidates <transcriptId>",
    "List stored extraction candidates for a transcript.",
  )
  .option(
    "--review-status [status]",
    z.enum(["pending", "approved", "rejected", "promoted"]).describe("Optional review state filter for extracted candidates."),
  )
  .action(async (transcriptId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const candidates = await listExtractionCandidates({ temple, transcriptId, reviewStatus: options.reviewStatus });
    await temple.close();
    if (candidates instanceof Error) return printError(candidates);

    return printOutput({
      json: options.json,
      human:
        candidates
          .map(
            (candidate) =>
              `${candidate.candidateType}${candidate.behavioralDimension ? `/${candidate.behavioralDimension}` : ""} ${candidate.statement}`,
          )
          .join("\n") || "No extraction candidates",
      value: candidates,
    });
  });

cli
  .command(
    "review candidate <candidateId>",
    "Approve, reject, or reset an extracted candidate before promotion.",
  )
  .option(
    "--status <status>",
    z.enum(["approve", "reject", "reset"]).describe("Review action to apply to the extracted candidate."),
  )
  .option(
    "--note [note]",
    z.string().describe("Optional review note stored with the candidate."),
  )
  .action(async (candidateId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await reviewExtractionCandidate({
      temple,
      candidateId,
      status: options.status,
      note: options.note,
    });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: `${result.candidateId} -> ${result.reviewStatus}`,
      value: result,
    });
  });

cli
  .command(
    "review clusters",
    "Cluster pending extracted candidates by semantic similarity to speed up operator review.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for clustering extracted candidates."),
  )
  .option(
    "--extraction [extractionRunId]",
    z.string().describe("Optional extraction run id for narrowing clusters."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const clusters = await clusterExtractionCandidates({
      temple,
      project: options.project,
      extractionRunId: options.extraction,
    });
    await temple.close();
    if (clusters instanceof Error) return printError(clusters);

    return printOutput({
      json: options.json,
      human: clusters.map((cluster) => `${cluster.id} size=${cluster.candidateIds.length} similarity=${cluster.similarity}`).join("\n") || "No candidate clusters",
      value: clusters,
    });
  });

cli
  .command(
    "promote extraction <extractionRunId>",
    "Promote extracted candidates into durable observations and episodic memories using the current promotion policy.",
  )
  .option(
    "--require-approval",
    "Only promote candidates that have been explicitly approved through the review flow.",
  )
  .action(async (extractionRunId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await promoteExtractionRun({ temple, extractionRunId, requireApproval: options.requireApproval });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: [
        result.duplicate
          ? `Promotion already exists for extraction run ${extractionRunId}`
          : `Created promotion run ${result.run.id}`,
        `observations: ${result.promotedObservationIds.length}`,
        `episodic memories: ${result.promotedMemoryIds.length}`,
        `skipped candidates: ${result.skippedCandidateIds.length}`,
      ].join("\n"),
      value: result,
    });
  });

cli
  .command(
    "promote runs",
    "List promotion runs that moved extracted candidates into durable memory.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for narrowing promotion runs."),
  )
  .option(
    "--extraction [extractionRunId]",
    z.string().describe("Optional extraction run id for narrowing promotion runs."),
  )
  .option(
    "--limit [limit]",
    z.int().default(20).describe("Maximum number of promotion runs to return."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const runs = await listPromotionRuns({
      temple,
      project: options.project,
      extractionRunId: options.extraction,
      limit: options.limit,
    });
    await temple.close();
    if (runs instanceof Error) return printError(runs);

    return printOutput({
      json: options.json,
      human:
        runs
          .map(
            (run) =>
              `${run.id} extraction=${run.extractionRunId} observations=${run.promotedObservationIds.length} memories=${run.promotedMemoryIds.length}`,
          )
          .join("\n") || "No promotion runs",
      value: runs,
    });
  });

cli
  .command(
    "eval retrieval [dataset]",
    "Run the committed retrieval benchmark and compare lexical-only retrieval against the current hybrid retrieval stack.",
  )
  .option(
    "--k [k]",
    z.int().default(5).describe("Top-K cutoff used for Recall@K and nDCG@K."),
  )
  .action(async (dataset, options) => {
    const report = await runRetrievalBenchmark({
      datasetPath: dataset ?? defaultRetrievalBenchmarkPath(),
      topK: options.k,
    });
    if (report instanceof Error) return printError(report);

    return printOutput({
      json: options.json,
      human: [
        `dataset: ${report.datasetName}`,
        `queries: ${report.queryCount}`,
        `topK: ${report.topK}`,
        "",
        `lexical recall@${report.topK}: ${report.lexical.recallAtK}`,
        `lexical mrr: ${report.lexical.mrr}`,
        `lexical ndcg@${report.topK}: ${report.lexical.ndcgAtK}`,
        "",
        `hybrid recall@${report.topK}: ${report.hybrid.recallAtK}`,
        `hybrid mrr: ${report.hybrid.mrr}`,
        `hybrid ndcg@${report.topK}: ${report.hybrid.ndcgAtK}`,
        "",
        `uplift recall@${report.topK}: ${report.uplift.recallAtK}`,
        `uplift mrr: ${report.uplift.mrr}`,
        `uplift ndcg@${report.topK}: ${report.uplift.ndcgAtK}`,
      ].join("\n"),
      value: report,
    });
  });

cli
  .command(
    "eval replay [dataset]",
    "Run the behavioral replay benchmark against the runtime orchestrator using seeded transcripts.",
  )
  .action(async (dataset, options) => {
    const report = await runBehavioralReplayBenchmark({ datasetPath: dataset ?? defaultRuntimeBenchmarkPath() });
    if (report instanceof Error) return printError(report);

    return printOutput({
      json: options.json,
      human: [
        `dataset: ${report.datasetName}`,
        `no-memory score: ${report.noMemory.score}`,
        `full-system score: ${report.fullSystem.score}`,
        `improvement: ${report.improvement}`,
      ].join("\n"),
      value: report,
    });
  });

cli
  .command(
    "eval calibration [dataset]",
    "Run the first-response calibration benchmark comparing startup-only context against the full runtime orchestrator.",
  )
  .action(async (dataset, options) => {
    const report = await runFirstResponseCalibrationBenchmark({ datasetPath: dataset ?? defaultRuntimeBenchmarkPath() });
    if (report instanceof Error) return printError(report);

    return printOutput({
      json: options.json,
      human: [
        `dataset: ${report.datasetName}`,
        `startup-only score: ${report.startupOnly.score}`,
        `full-system score: ${report.fullSystem.score}`,
        `improvement: ${report.improvement}`,
      ].join("\n"),
      value: report,
    });
  });

cli
  .command(
    "eval uplift [runtimeDataset]",
    "Run the composite local-model uplift benchmark using behavioral replay, first-response calibration, and retrieval uplift.",
  )
  .option(
    "--retrieval-dataset [dataset]",
    z.string().describe("Optional retrieval benchmark dataset path. Defaults to the committed retrieval benchmark."),
  )
  .action(async (runtimeDataset, options) => {
    const report = await runLocalModelUpliftBenchmark({
      runtimeDatasetPath: runtimeDataset ?? defaultRuntimeBenchmarkPath(),
      retrievalDatasetPath: options.retrievalDataset ?? defaultRetrievalBenchmarkPath(),
    });
    if (report instanceof Error) return printError(report);

    return printOutput({
      json: options.json,
      human: [
        `behavioral replay improvement: ${report.behavioralReplayImprovement}`,
        `first-response improvement: ${report.firstResponseImprovement}`,
        `retrieval ndcg improvement: ${report.retrievalNdcgImprovement}`,
        `composite improvement: ${report.compositeImprovement}`,
      ].join("\n"),
      value: report,
    });
  });

cli
  .command(
    "runtime plan <message>",
    "Preview the runtime orchestrator plan for a user message, including retrieval decisions and synthesized system messages.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for the runtime plan."),
  )
  .option(
    "--max-prompt [tokens]",
    z.int().default(4096).describe("Approximate prompt budget used for runtime planning."),
  )
  .action(async (message, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const plan = await prepareRuntimeTurn({
      temple,
      project: options.project,
      maxPromptTokens: options.maxPrompt,
      messages: [{ role: "user", content: message }],
    });
    await temple.close();
    if (plan instanceof Error) return printError(plan);

    return printOutput({
      json: options.json,
      human: [
        `bootstrap: ${plan.shouldBootstrap}`,
        `retrieve: ${plan.shouldRetrieve}`,
        `retrieval query: ${plan.retrievalQuery ?? "none"}`,
        `rules: ${plan.rules.length}`,
        `retrieved memories: ${plan.retrievedMemories.length}`,
        "",
        ...plan.systemMessages,
      ].join("\n"),
      value: plan,
    });
  });

cli
  .command(
    "runtime complete <message>",
    "Run runtime writeback for a completed assistant turn using the latest user message and assistant response.",
  )
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for the writeback."),
  )
  .option(
    "--assistant <assistant>",
    z.string().describe("Assistant response content for the completed turn."),
  )
  .option(
    "--session [sessionId]",
    z.string().describe("Optional runtime session identifier stored in writeback sources."),
  )
  .action(async (message, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await completeRuntimeTurn({
      temple,
      project: options.project,
      sessionId: options.session,
      messages: [{ role: "user", content: message }],
      assistantMessage: options.assistant,
    });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: `observations: ${result.observationsAdded.length}\nmemories: ${result.memoriesAdded.length}`,
      value: result,
    });
  });

cli
  .command("conflicts rules", "List detected rule conflicts that currently block rules from remaining active.")
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const conflicts = await listRuleConflictRecords({ temple });
    await temple.close();
    if (conflicts instanceof Error) return printError(conflicts);

    return printOutput({
      json: options.json,
      human:
        conflicts
          .map((conflict) => `${conflict.status} ${conflict.leftRuleId} <-> ${conflict.rightRuleId} reason=${conflict.reason}`)
          .join("\n") || "No rule conflicts",
      value: conflicts,
    });
  });

cli
  .command("conflicts resolve-rule <conflictId>", "Resolve a rule conflict by selecting which side should remain active.")
  .option(
    "--winner <winner>",
    z.enum(["left", "right", "both"]).describe("Which side should win the conflict resolution."),
  )
  .option(
    "--note [note]",
    z.string().describe("Optional operator note attached to the resolution."),
  )
  .action(async (conflictId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await resolveRuleConflict({ temple, conflictId, winner: options.winner, note: options.note });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({ json: options.json, human: `${conflictId} resolved -> ${result.winner}`, value: result });
  });

cli
  .command("conflicts memories", "List detected episodic memory conflicts and supersession issues.")
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const conflicts = await listMemoryConflictRecords({ temple });
    await temple.close();
    if (conflicts instanceof Error) return printError(conflicts);

    return printOutput({
      json: options.json,
      human:
        conflicts
          .map((conflict) => `${conflict.status} ${conflict.leftMemoryId} <-> ${conflict.rightMemoryId} reason=${conflict.reason}`)
          .join("\n") || "No memory conflicts",
      value: conflicts,
    });
  });

cli
  .command("conflicts resolve-memory <conflictId>", "Resolve a memory conflict by selecting the winner or restoring both.")
  .option(
    "--winner <winner>",
    z.enum(["left", "right", "both"]).describe("Which side should win the memory conflict resolution."),
  )
  .option(
    "--note [note]",
    z.string().describe("Optional operator note attached to the memory conflict resolution."),
  )
  .action(async (conflictId, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await resolveMemoryConflict({ temple, conflictId, winner: options.winner, note: options.note });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({ json: options.json, human: `${conflictId} resolved -> ${result.winner}`, value: result });
  });

cli
  .command("snapshot export <output>", "Copy the local SQLite store to a backup path for export and recovery.")
  .action(async (output, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await exportTempleSnapshot({ temple, outputPath: output });
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: `Exported ContextTemple snapshot to ${result.outputPath}`,
      value: result,
    });
  });

cli
  .command("memory forget", "Archive low-value active memories using usefulness feedback and age thresholds.")
  .option(
    "--project [project]",
    z.string().describe("Optional project scope for active forgetting."),
  )
  .option(
    "--usefulness [threshold]",
    z.number().default(0.25).describe("Archive memories at or below this usefulness score."),
  )
  .option(
    "--age-days [days]",
    z.int().default(90).describe("Minimum age in days before a low-value memory can be archived."),
  )
  .option(
    "--dry-run",
    "Preview which memories would be archived without changing their status.",
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await runActiveForgetting({
      temple,
      project: options.project,
      usefulnessThreshold: options.usefulness,
      maxAgeDays: options.ageDays,
      dryRun: options.dryRun,
    });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: `${options.dryRun ? "would archive" : "archived"} ${result.archivedMemoryIds.length} memories`,
      value: result,
    });
  });

cli
  .command("snapshot import <input>", "Restore the local SQLite store from a snapshot file.")
  .action(async (input, options) => {
    const result = await importTempleSnapshot({ homeDir: options.home, snapshotPath: input });
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: `Imported ContextTemple snapshot into ${result.dbPath}`,
      value: result,
    });
  });

cli
  .command("snapshot purge-project <project>", "Delete project-scoped memory, transcripts, and derived artifacts for one project.")
  .action(async (project, options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const result = await purgeProjectData({ temple, project });
    await temple.close();
    if (result instanceof Error) return printError(result);

    return printOutput({
      json: options.json,
      human: [
        `purged observations: ${result.observations}`,
        `purged behavioral rules: ${result.behavioralRules}`,
        `purged episodic memories: ${result.episodicMemories}`,
        `purged transcripts: ${result.transcripts}`,
      ].join("\n"),
      value: result,
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
        `transcripts: ${status.transcripts}`,
        `transcript events: ${status.transcriptEvents}`,
        `extraction runs: ${status.extractionRuns}`,
        `extracted candidates: ${status.extractedCandidates}`,
        `promotion runs: ${status.promotionRuns}`,
        `rule conflicts: ${status.ruleConflicts}`,
        `memory conflicts: ${status.memoryConflicts}`,
      ].join("\n"),
      value: status,
    });
  });

cli
  .command(
    "bridge llamacpp",
    "Start an OpenAI-compatible proxy in front of llama.cpp that injects ContextTemple runtime planning and writeback.",
  )
  .option(
    "--llama-url [url]",
    z.string().default("http://127.0.0.1:8080").describe("Base URL for the upstream llama.cpp server exposing /v1/chat/completions."),
  )
  .option(
    "--port [port]",
    z.int().default(4001).describe("Port to listen on for the ContextTemple llama.cpp bridge."),
  )
  .option(
    "--project [project]",
    z.string().describe("Optional default project scope applied when the client does not send x-contexttemple-project."),
  )
  .action(async (options) => {
    const temple = await openTempleDatabase({ homeDir: options.home });
    if (temple instanceof Error) return printError(temple);

    const server = startLlamaCppBridgeServer({
      temple,
      llamaCppUrl: options.llamaUrl,
      port: options.port,
      defaultProject: options.project,
    });
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
      human: `ContextTemple llama.cpp bridge listening on http://localhost:${server.server.port}`,
      value: { port: server.server.port, llamaCppUrl: options.llamaUrl },
    });
  });

cli
  .command("mcp", "Start the ContextTemple MCP server over stdio for MCP-compatible clients.")
  .action(async () => {
    const server = await startContextTempleMcpServer().catch((error) => error as Error);
    if (server instanceof Error) return printError(server);
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
