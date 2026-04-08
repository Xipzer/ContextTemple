# ContextTemple

ContextTemple is a hybrid memory layer for LLM agents.

It combines two memory systems that most projects keep separate:

- behavioral memory: durable rules about how the model should work with a specific user
- episodic memory: retrievable facts, decisions, and artifacts from prior sessions

The goal is simple: make an existing LLM feel smarter by improving both behavior and recall.

## Why this exists

Most memory systems over-index on storage and retrieval. That helps recall, but it does not stop the model from being annoying, repetitive, or miscalibrated.

Most profile systems over-index on prompt injection. That helps behavior, but it cannot answer factual questions about what actually happened last week.

ContextTemple combines both:

```text
┌──────────────────────────────────────────────────────┐
│ Startup context                                      │
│ - behavioral rules                                   │
│ - working style                                      │
│ - failure guards                                     │
└──────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────┐
│ Runtime recall                                       │
│ - episodic search                                    │
│ - recency + salience scoring                         │
│ - scoped retrieval by project                        │
└──────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────┐
│ Consolidation                                        │
│ - repeated observations become rules                 │
│ - cross-project rules are promoted global            │
│ - retrieval feedback changes salience over time      │
└──────────────────────────────────────────────────────┘
```

## Release Status

`1.2.0` closes the frontier model suitability gap so the system works equally well for local models and frontier agents.

Current shipped surface:

- transcript ingestion
- extraction and promotion
- behavioral and episodic memory
- hybrid retrieval with reranking
- runtime orchestration
- contradiction-aware lifecycle handling
- benchmark harness (retrieval, behavioral replay, calibration, uplift, frontier)
- llama.cpp bridge (streamed and non-streamed)
- MCP server (18 tools)
- agent instructions generator (CLAUDE.md / AGENTS.md compatible)
- Kimaki/OpenCode session transcript adapter
- post-session consolidation and instructions update hooks
- backup and restore tooling

## Current implementation

`1.2.0` ships the complete release surface:

- SQLite-backed local storage through Drizzle + libSQL
- canonical transcript ingestion with persisted replayable events
- heuristic extraction from transcripts into decisions, observations, facts, and outcomes
- promotion from extracted candidates into durable observations and episodic memory
- behavioral observations and rule consolidation
- episodic memory capture and hybrid lexical plus semantic retrieval with reranking
- retrieval benchmark harness with lexical-vs-hybrid comparison
- runtime orchestrator with retrieval and writeback policy
- contradiction-aware lifecycle management for rules and memories
- explicit candidate review and conflict resolution flows
- active forgetting driven by retrieval usefulness feedback
- learned embedding provider abstraction with local and remote provider support
- semantic clustering for pending review queues
- llama.cpp bridge with OpenAI-compatible `/v1/chat/completions`
- streamed llama.cpp bridge support
- MCP server over stdio for MCP-compatible clients
- backup, restore, and project-scoped purge tooling
- behavioral replay, first-response calibration, and local-model uplift evals
- startup context synthesis that merges behavioral and episodic memory
- Bun CLI for ingest, search, consolidation, and serving
- Hono HTTP API for programmatic integration

The baseline is deterministic and local-first. No model provider is required to get value.

## Benchmark Snapshot

Current committed eval snapshot from the fixture-backed harness:

- retrieval benchmark:
  - lexical `MRR`: `0.75`
  - hybrid `MRR`: `0.9`
  - lexical `nDCG@5`: `0.8123`
  - hybrid `nDCG@5`: `0.9262`
- behavioral replay improvement: `1`
- first-response calibration improvement: `1`
- composite local-model uplift: `0.7342`
- frontier suitability composite: `1`

Full stored benchmark history lives in `BENCHMARKS.md`.

## Quick start

```bash
bun install
bun run build

# initialize the local temple
bun run src/cli.ts init

# preview and ingest a transcript into canonical events
bun run src/cli.ts transcript ingest ./fixtures/transcripts/jsonl-session.jsonl --preview
bun run src/cli.ts transcript ingest ./fixtures/transcripts/jsonl-session.jsonl --project core

# extract structured candidates from an imported transcript
bun run src/cli.ts extract transcript <transcript-id>
bun run src/cli.ts extract candidates <transcript-id>

# promote extracted candidates into durable memory
bun run src/cli.ts promote extraction <extraction-run-id>
bun run src/cli.ts consolidate --project core

# run the retrieval benchmark harness
bun run src/cli.ts eval retrieval

# run the runtime evals
bun run src/cli.ts eval replay
bun run src/cli.ts eval calibration
bun run src/cli.ts eval uplift

# preview the runtime orchestrator and start a llama.cpp bridge
bun run src/cli.ts runtime plan "What auth flow did we choose?" --project demo
bun run src/cli.ts bridge llamacpp --llama-url http://127.0.0.1:8080 --port 4001

# start the MCP server over stdio
bun run src/cli.ts mcp

# review, resolve, and forget low-value memory
bun run src/cli.ts review clusters --project demo
bun run src/cli.ts review candidate <candidate-id> --status approve
bun run src/cli.ts conflicts resolve-rule <conflict-id> --winner left
bun run src/cli.ts memory forget --project demo --dry-run

# backup and restore the SQLite store
bun run src/cli.ts snapshot export ./backups/contexttemple.db
bun run src/cli.ts snapshot import ./backups/contexttemple.db

# add episodic memory
bun run src/cli.ts remember --content "We decided to migrate auth to OAuth device flow" --project core --tag auth --tag oauth

# capture a behavioral correction
bun run src/cli.ts observe --statement "Always read the target file before editing it" --dimension guard --project core

# promote observations into durable rules
bun run src/cli.ts consolidate

# generate startup context for an agent
bun run src/cli.ts wake auth --project core

# run the API server
bun run src/cli.ts serve --port 4000
```

## CLI commands

- `init`: initialize the local ContextTemple database
- `remember`: add an episodic memory
- `observe`: record a behavioral correction or preference
- `consolidate`: merge fresh observations into durable rules
- `search`: retrieve episodic memories for a query
- `transcript ingest`: normalize and persist raw transcripts
- `transcript list`: inspect imported transcript sources
- `transcript events`: inspect canonical transcript events
- `extract transcript`: persist extracted decisions, observations, facts, and outcomes
- `extract runs`: inspect extraction runs
- `extract candidates`: inspect extracted candidates
- `review candidate`: approve, reject, or reset an extracted candidate
- `review clusters`: cluster pending candidates for operator review
- `promote extraction`: move extracted candidates into durable observations and episodic memory
- `promote runs`: inspect promotion runs
- `eval retrieval`: run the committed retrieval benchmark with lexical vs hybrid comparison
- `eval replay`: run the behavioral replay benchmark
- `eval calibration`: run the first-response calibration benchmark
- `eval uplift`: run the composite local-model uplift benchmark
- `runtime plan`: preview the runtime orchestrator plan for a user turn
- `runtime complete`: write back observations and durable outcomes for a completed turn
- `conflicts rules`: inspect rule conflicts
- `conflicts resolve-rule`: resolve a rule conflict
- `conflicts memories`: inspect memory conflicts
- `conflicts resolve-memory`: resolve a memory conflict
- `memory forget`: archive low-value memories using usefulness feedback
- `snapshot export`: backup the SQLite store
- `snapshot import`: restore the SQLite store
- `snapshot purge-project`: delete one project's stored memory and derived artifacts
- `bridge llamacpp`: start an OpenAI-compatible llama.cpp bridge with ContextTemple orchestration
- `mcp`: start the MCP server over stdio
- `wake`: synthesize startup context for an agent session
- `status`: inspect memory counts
- `serve`: expose the same flows through a local HTTP API

## HTTP API

- `GET /health`
- `GET /stats`
- `POST /api/memories`
- `POST /api/observations`
- `POST /api/consolidate`
- `POST /api/extract/transcripts/:transcriptId`
- `GET /api/extract/runs`
- `GET /api/extract/candidates`
- `POST /api/review/candidates/:candidateId`
- `GET /api/review/clusters`
- `POST /api/promote/extractions/:extractionRunId`
- `GET /api/promote/runs`
- `GET /api/conflicts/rules`
- `POST /api/conflicts/rules/:conflictId/resolve`
- `GET /api/conflicts/memories`
- `POST /api/conflicts/memories/:conflictId/resolve`
- `POST /api/maintenance/forget`
- `POST /api/runtime/plan`
- `POST /api/runtime/complete`
- `GET /api/search?q=...`
- `GET /api/context?query=...`
- `POST /api/feedback`

## Architecture

See `docs/architecture.md` for the full design, including the shipped runtime, lifecycle, evaluation, bridge, MCP, review, and forgetting layers.

For the strict deployment gate and implementation order toward a real `v1.0`, see `docs/v1-readiness.md`.

For the stored benchmark history and release snapshots, see `BENCHMARKS.md`.

## Roadmap

There are no active core roadmap items remaining from the original release plan.

Future work from here is optional expansion rather than unfinished core scope.

## Version

Current release: `1.2.0`

## License

MIT
