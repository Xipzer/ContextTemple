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

## Current implementation

`0.1.0` ships the first working layer:

- SQLite-backed local storage through Drizzle + libSQL
- behavioral observations and rule consolidation
- episodic memory capture and hybrid lexical retrieval
- startup context synthesis that merges behavioral and episodic memory
- Bun CLI for ingest, search, consolidation, and serving
- Hono HTTP API for programmatic integration

The baseline is deterministic and local-first. No model provider is required to get value.

## Quick start

```bash
bun install
bun run build

# initialize the local temple
bun run src/cli.ts init

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
- `wake`: synthesize startup context for an agent session
- `status`: inspect memory counts
- `serve`: expose the same flows through a local HTTP API

## HTTP API

- `GET /health`
- `GET /stats`
- `POST /api/memories`
- `POST /api/observations`
- `POST /api/consolidate`
- `GET /api/search?q=...`
- `GET /api/context?query=...`
- `POST /api/feedback`

## Architecture

See `docs/architecture.md` for the full design, including the layers that are implemented now and the next layers planned for embeddings, MCP, and evaluation.

## Roadmap

- MCP server for direct agent tool integration
- embedding-backed retrieval and clustering
- rule contradiction detection and expiry windows
- automatic transcript ingestion
- retrieval usefulness scoring and active forgetting

## License

MIT
