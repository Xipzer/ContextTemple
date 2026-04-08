import { describe, expect, test } from "bun:test";

import { defaultRuntimeBenchmarkPath, runBehavioralReplayBenchmark, runFirstResponseCalibrationBenchmark, runLocalModelUpliftBenchmark } from "./replay.ts";

describe("runtime eval benchmarks", () => {
  test("behavioral replay shows improvement over no-memory baseline", async () => {
    const report = await runBehavioralReplayBenchmark({ datasetPath: defaultRuntimeBenchmarkPath() });
    if (report instanceof Error) throw report;

    expect(report.fullSystem.score).toBeGreaterThan(report.noMemory.score);
    expect(report.improvement).toBeGreaterThan(0);
  });

  test("first-response calibration shows improvement from startup-only to full system", async () => {
    const report = await runFirstResponseCalibrationBenchmark({ datasetPath: defaultRuntimeBenchmarkPath() });
    if (report instanceof Error) throw report;

    expect(report.fullSystem.score).toBeGreaterThanOrEqual(report.startupOnly.score);
    expect(report.improvement).toBeGreaterThanOrEqual(0);
  });

  test("local-model uplift benchmark aggregates positive improvements", async () => {
    const report = await runLocalModelUpliftBenchmark({ runtimeDatasetPath: defaultRuntimeBenchmarkPath() });
    if (report instanceof Error) throw report;

    expect(report.behavioralReplayImprovement).toBeGreaterThan(0);
    expect(report.retrievalNdcgImprovement).toBeGreaterThan(0);
    expect(report.compositeImprovement).toBeGreaterThan(0);
  });
});
