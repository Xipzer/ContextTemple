import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as errore from "errore";

import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase, type TempleDatabase } from "../db.ts";
import { FileReadError, JsonParsingError, ValidationError } from "../errors.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";
import { prepareRuntimeTurn } from "../runtime/orchestrator.ts";
import type {
  BehavioralReplayReport,
  FirstResponseCalibrationReport,
  LocalModelUpliftReport,
  RuntimeBenchmarkCase,
  RuntimeBenchmarkDataset,
  RuntimeBenchmarkModeReport,
} from "./runtime-types.ts";
import { defaultRetrievalBenchmarkPath, runRetrievalBenchmark } from "./retrieval.ts";

export function defaultRuntimeBenchmarkPath() {
  return path.resolve(import.meta.dir, "../../fixtures/evals/runtime-benchmark.json");
}

export async function loadRuntimeBenchmarkDataset(datasetPath = defaultRuntimeBenchmarkPath()) {
  const fileText = await fs.readFile(datasetPath, "utf8").catch((cause) => new FileReadError({ path: datasetPath, cause }));
  if (fileText instanceof Error) return fileText;

  const parsed = errore.try({
    try: () => JSON.parse(fileText) as unknown,
    catch: (cause) => new JsonParsingError({ context: `runtime-benchmark:${datasetPath}`, cause }),
  });
  if (parsed instanceof Error) return parsed;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new ValidationError({ field: "runtime dataset", reason: "must be an object" });
  }

  return parsed as RuntimeBenchmarkDataset;
}

export async function runBehavioralReplayBenchmark({ datasetPath }: { datasetPath?: string } = {}) {
  const dataset = await loadRuntimeBenchmarkDataset(datasetPath);
  if (dataset instanceof Error) return dataset;

  const noMemory = dataset.behavioralCases.map((scenario) => evaluateNoMemoryCase(scenario));
  const fullSystem = await runRuntimeCases({ dataset, cases: dataset.behavioralCases, mode: "full-system" });
  if (fullSystem instanceof Error) return fullSystem;

  return {
    datasetName: dataset.name,
    noMemory: summarizeRuntimeReports({ mode: "no-memory", reports: noMemory }),
    fullSystem: summarizeRuntimeReports({ mode: "full-system", reports: fullSystem }),
    improvement: roundMetric(scoreReports(fullSystem) - scoreReports(noMemory)),
  } satisfies BehavioralReplayReport;
}

export async function runFirstResponseCalibrationBenchmark({ datasetPath }: { datasetPath?: string } = {}) {
  const dataset = await loadRuntimeBenchmarkDataset(datasetPath);
  if (dataset instanceof Error) return dataset;

  const startupOnly = await runRuntimeCases({ dataset, cases: dataset.calibrationCases, mode: "startup-only" });
  if (startupOnly instanceof Error) return startupOnly;
  const fullSystem = await runRuntimeCases({ dataset, cases: dataset.calibrationCases, mode: "full-system" });
  if (fullSystem instanceof Error) return fullSystem;

  return {
    datasetName: dataset.name,
    startupOnly: summarizeRuntimeReports({ mode: "startup-only", reports: startupOnly }),
    fullSystem: summarizeRuntimeReports({ mode: "full-system", reports: fullSystem }),
    improvement: roundMetric(scoreReports(fullSystem) - scoreReports(startupOnly)),
  } satisfies FirstResponseCalibrationReport;
}

export async function runLocalModelUpliftBenchmark({
  runtimeDatasetPath,
  retrievalDatasetPath,
}: {
  runtimeDatasetPath?: string;
  retrievalDatasetPath?: string;
} = {}) {
  const [behavioralReplay, calibration, retrieval] = await Promise.all([
    runBehavioralReplayBenchmark({ datasetPath: runtimeDatasetPath }),
    runFirstResponseCalibrationBenchmark({ datasetPath: runtimeDatasetPath }),
    runRetrievalBenchmark({ datasetPath: retrievalDatasetPath ?? defaultRetrievalBenchmarkPath(), topK: 5 }),
  ]);

  if (behavioralReplay instanceof Error) return behavioralReplay;
  if (calibration instanceof Error) return calibration;
  if (retrieval instanceof Error) return retrieval;

  const compositeImprovement = roundMetric(
    behavioralReplay.improvement * 0.35 + calibration.improvement * 0.35 + retrieval.uplift.ndcgAtK * 0.3,
  );

  return {
    behavioralReplayImprovement: behavioralReplay.improvement,
    firstResponseImprovement: calibration.improvement,
    retrievalNdcgImprovement: retrieval.uplift.ndcgAtK,
    compositeImprovement,
  } satisfies LocalModelUpliftReport;
}

async function runRuntimeCases({
  dataset,
  cases,
  mode,
}: {
  dataset: RuntimeBenchmarkDataset;
  cases: RuntimeBenchmarkCase[];
  mode: "startup-only" | "full-system";
}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-runtime-benchmark-"));

  try {
    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) return temple;

    const seedResult = await seedBenchmarkTemple({ temple, dataset });
    if (seedResult instanceof Error) {
      await temple.close();
      return seedResult;
    }

    const reports = [];
    for (const scenario of cases) {
      const plan = await prepareRuntimeTurn({
        temple,
        project: scenario.project,
        messages: [{ role: "user", content: scenario.message }],
      });
      if (plan instanceof Error) {
        await temple.close();
        return plan;
      }

      const matchedRules = scenario.expectedRuleSubstrings?.filter((needle) => plan.systemMessages.join("\n").includes(needle)) ?? [];
      const matchedMemories =
        mode === "full-system"
          ? scenario.expectedMemorySubstrings?.filter((needle) => plan.systemMessages.join("\n").includes(needle)) ?? []
          : [];
      const success =
        matchedRules.length === (scenario.expectedRuleSubstrings?.length ?? 0) &&
        matchedMemories.length === (scenario.expectedMemorySubstrings?.length ?? 0);

      reports.push({
        caseId: scenario.id,
        project: scenario.project,
        message: scenario.message,
        expectedRuleSubstrings: scenario.expectedRuleSubstrings ?? [],
        expectedMemorySubstrings: scenario.expectedMemorySubstrings ?? [],
        matchedRules,
        matchedMemories,
        success,
      });
    }

    await temple.close();
    return reports;
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function seedBenchmarkTemple({ temple, dataset }: { temple: TempleDatabase; dataset: RuntimeBenchmarkDataset }) {
  for (const seed of dataset.seedTranscripts) {
    const transcriptPath = path.resolve(process.cwd(), seed.path);
    const imported = await importTranscript({ temple, filePath: transcriptPath, project: seed.project });
    if (imported instanceof Error) return imported;

    const extraction = await extractTranscriptCandidates({ temple, transcriptId: imported.transcript.id });
    if (extraction instanceof Error) return extraction;

    const promotion = await promoteExtractionRun({ temple, extractionRunId: extraction.run.id });
    if (promotion instanceof Error) return promotion;
  }

  return runConsolidationCycle({ temple });
}

function evaluateNoMemoryCase(scenario: RuntimeBenchmarkCase) {
  return {
    caseId: scenario.id,
    project: scenario.project,
    message: scenario.message,
    expectedRuleSubstrings: scenario.expectedRuleSubstrings ?? [],
    expectedMemorySubstrings: scenario.expectedMemorySubstrings ?? [],
    matchedRules: [],
    matchedMemories: [],
    success: false,
  };
}

function summarizeRuntimeReports({
  mode,
  reports,
}: {
  mode: RuntimeBenchmarkModeReport["mode"];
  reports: RuntimeBenchmarkModeReport["reports"];
}) {
  return {
    mode,
    score: roundMetric(scoreReports(reports)),
    reports,
  } satisfies RuntimeBenchmarkModeReport;
}

function scoreReports(reports: Array<{ success: boolean }>) {
  return reports.length === 0 ? 0 : reports.filter((report) => report.success).length / reports.length;
}

function roundMetric(value: number) {
  return Number(value.toFixed(4));
}
