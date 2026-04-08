import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runConsolidationCycle } from "../consolidation.ts";
import { openTempleDatabase, type TempleDatabase } from "../db.ts";
import { FileReadError, JsonParsingError, ValidationError } from "../errors.ts";
import { extractTranscriptCandidates } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";
import { executeContextTempleMcpTool } from "../mcp/server.ts";
import { generateAgentInstructions } from "../frontier/instructions.ts";
import * as errore from "errore";

export type FrontierBenchmarkDataset = {
  name: string;
  description: string;
  seedTranscripts: Array<{ path: string; project: string }>;
  toolCallingCases: FrontierToolCallingCase[];
  instructionsCases: FrontierInstructionsCase[];
};

export type FrontierToolCallingCase = {
  id: string;
  project: string;
  description: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  expectSuccess: boolean;
  expectResultContains?: string[];
};

export type FrontierInstructionsCase = {
  id: string;
  project: string;
  format: "claude-md" | "agents-md" | "raw-markdown";
  expectContains: string[];
};

export type FrontierCaseReport = {
  caseId: string;
  success: boolean;
  reason: string;
};

export type FrontierBenchmarkReport = {
  datasetName: string;
  toolCallingScore: number;
  instructionsScore: number;
  compositeScore: number;
  toolCallingReports: FrontierCaseReport[];
  instructionsReports: FrontierCaseReport[];
};

export function defaultFrontierBenchmarkPath() {
  return path.resolve(import.meta.dir, "../../fixtures/evals/frontier-benchmark.json");
}

export async function loadFrontierBenchmarkDataset(datasetPath = defaultFrontierBenchmarkPath()) {
  const fileText = await fs.readFile(datasetPath, "utf8").catch((cause) => new FileReadError({ path: datasetPath, cause }));
  if (fileText instanceof Error) return fileText;

  const parsed = errore.try({
    try: () => JSON.parse(fileText) as unknown,
    catch: (cause) => new JsonParsingError({ context: `frontier-benchmark:${datasetPath}`, cause }),
  });
  if (parsed instanceof Error) return parsed;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new ValidationError({ field: "frontier dataset", reason: "must be an object" });
  }

  return parsed as FrontierBenchmarkDataset;
}

export async function runFrontierBenchmark({ datasetPath }: { datasetPath?: string } = {}) {
  const dataset = await loadFrontierBenchmarkDataset(datasetPath);
  if (dataset instanceof Error) return dataset;

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "contexttemple-frontier-eval-"));

  try {
    const temple = await openTempleDatabase({ homeDir: home });
    if (temple instanceof Error) return temple;

    const seedResult = await seedFrontierTemple({ temple, dataset, home });
    if (seedResult instanceof Error) {
      await temple.close();
      return seedResult;
    }

    const toolCallingReports = await evaluateToolCallingCases({ temple, cases: dataset.toolCallingCases, home });
    if (toolCallingReports instanceof Error) {
      await temple.close();
      return toolCallingReports;
    }

    const instructionsReports = await evaluateInstructionsCases({ temple, cases: dataset.instructionsCases });
    if (instructionsReports instanceof Error) {
      await temple.close();
      return instructionsReports;
    }

    await temple.close();

    const toolCallingScore = scoreReports(toolCallingReports);
    const instructionsScore = scoreReports(instructionsReports);

    return {
      datasetName: dataset.name,
      toolCallingScore: roundMetric(toolCallingScore),
      instructionsScore: roundMetric(instructionsScore),
      compositeScore: roundMetric(toolCallingScore * 0.6 + instructionsScore * 0.4),
      toolCallingReports,
      instructionsReports,
    } satisfies FrontierBenchmarkReport;
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function seedFrontierTemple({
  temple,
  dataset,
  home,
}: {
  temple: TempleDatabase;
  dataset: FrontierBenchmarkDataset;
  home: string;
}) {
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

async function evaluateToolCallingCases({
  temple,
  cases,
  home,
}: {
  temple: TempleDatabase;
  cases: FrontierToolCallingCase[];
  home: string;
}) {
  const reports: FrontierCaseReport[] = [];

  for (const testCase of cases) {
    const args = { ...testCase.toolArgs, homeDir: home };
    const result = await executeContextTempleMcpTool({
      name: testCase.toolName as any,
      args,
    });

    const isError = result instanceof Error;
    const succeeded = testCase.expectSuccess ? !isError : isError;

    let containsExpected = true;
    if (succeeded && !isError && testCase.expectResultContains) {
      const resultText = JSON.stringify(result);
      for (const needle of testCase.expectResultContains) {
        if (!resultText.includes(needle)) {
          containsExpected = false;
          break;
        }
      }
    }

    const success = succeeded && containsExpected;
    reports.push({
      caseId: testCase.id,
      success,
      reason: success
        ? "passed"
        : isError && testCase.expectSuccess
          ? `tool returned error: ${result.message}`
          : !containsExpected
            ? "result did not contain expected substrings"
            : "unexpected result state",
    });
  }

  return reports;
}

async function evaluateInstructionsCases({
  temple,
  cases,
}: {
  temple: TempleDatabase;
  cases: FrontierInstructionsCase[];
}) {
  const reports: FrontierCaseReport[] = [];

  for (const testCase of cases) {
    const instructions = await generateAgentInstructions({
      temple,
      project: testCase.project,
      format: testCase.format,
    });
    if (instructions instanceof Error) {
      reports.push({
        caseId: testCase.id,
        success: false,
        reason: `instructions generation failed: ${instructions.message}`,
      });
      continue;
    }

    let allContained = true;
    for (const needle of testCase.expectContains) {
      if (!instructions.markdown.includes(needle)) {
        allContained = false;
        break;
      }
    }

    reports.push({
      caseId: testCase.id,
      success: allContained,
      reason: allContained ? "passed" : "instructions did not contain expected content",
    });
  }

  return reports;
}

function scoreReports(reports: FrontierCaseReport[]) {
  return reports.length === 0 ? 0 : reports.filter((report) => report.success).length / reports.length;
}

function roundMetric(value: number) {
  return Number(value.toFixed(4));
}
