# Benchmarks

This file stores durable benchmark snapshots for released ContextTemple versions.

## Snapshot: 1.2.0

- Version: `1.2.0`
- Commit: `6257406`
- Benchmark source: current checked-out codebase state
- Execution method: fixture-backed deterministic CLI benchmark suite

### Commands

```bash
bun run src/cli.ts eval retrieval --json
bun run src/cli.ts eval replay --json
bun run src/cli.ts eval calibration --json
bun run src/cli.ts eval uplift --json
bun run src/cli.ts eval frontier --json
```

### Retrieval Benchmark

- Dataset: `contexttemple-retrieval-v1`
- Top K: `5`
- Query count: `5`
- Lexical `Recall@5`: `1.0`
- Lexical `MRR`: `0.75`
- Lexical `nDCG@5`: `0.8123`
- Hybrid `Recall@5`: `1.0`
- Hybrid `MRR`: `0.9`
- Hybrid `nDCG@5`: `0.9262`
- Uplift `MRR`: `+0.15`
- Uplift `nDCG@5`: `+0.1139`

### Behavioral Replay Benchmark

- Dataset: `contexttemple-runtime-v1`
- No-memory score: `0.0`
- Full-system score: `1.0`
- Improvement: `+1.0`

### First-Response Calibration Benchmark

- Dataset: `contexttemple-runtime-v1`
- Startup-only score: `0.0`
- Full-system score: `1.0`
- Improvement: `+1.0`

### Composite Uplift Benchmark

- Behavioral replay improvement: `1.0`
- First-response improvement: `1.0`
- Retrieval `nDCG` improvement: `0.1139`
- Composite improvement: `0.7342`

### Frontier Suitability Benchmark

- Dataset: `contexttemple-frontier-v1`
- Tool-calling score: `1.0`
- Instructions score: `1.0`
- Composite score: `1.0`

### Summary

- Local model path: passing
- Frontier MCP + instructions path: passing
- Hybrid retrieval continues to outperform lexical-only ranking on fixture-backed evaluation
- The current stored benchmark snapshot reflects the released `1.2.0` codebase state
