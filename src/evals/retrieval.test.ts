import { describe, expect, test } from "bun:test";

import { defaultRetrievalBenchmarkPath, runRetrievalBenchmark } from "./retrieval.ts";

describe("retrieval benchmark", () => {
  test("hybrid retrieval outperforms or matches lexical baseline on the committed dataset", async () => {
    const report = await runRetrievalBenchmark({ datasetPath: defaultRetrievalBenchmarkPath(), topK: 5 });
    if (report instanceof Error) throw report;

    expect(report.queryCount).toBeGreaterThan(0);
    expect(report.hybrid.recallAtK).toBeGreaterThanOrEqual(report.lexical.recallAtK);
    expect(report.hybrid.ndcgAtK).toBeGreaterThanOrEqual(report.lexical.ndcgAtK);
    expect(report.hybrid.mrr).toBeGreaterThanOrEqual(report.lexical.mrr);
    expect(report.hybrid.recallAtK).toBeGreaterThan(0.7);
    expect(report.uplift.mrr > 0 || report.uplift.ndcgAtK > 0 || report.uplift.recallAtK > 0).toBe(true);
  });
});
