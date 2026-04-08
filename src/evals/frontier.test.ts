import { describe, expect, test } from "bun:test";

import { defaultFrontierBenchmarkPath, runFrontierBenchmark } from "./frontier.ts";

describe("frontier eval benchmark", () => {
  test("MCP tools are callable and agent instructions contain expected content", async () => {
    const report = await runFrontierBenchmark({ datasetPath: defaultFrontierBenchmarkPath() });
    if (report instanceof Error) throw report;

    expect(report.toolCallingScore).toBeGreaterThan(0.8);
    expect(report.instructionsScore).toBe(1);
    expect(report.compositeScore).toBeGreaterThan(0.8);
  });
});
