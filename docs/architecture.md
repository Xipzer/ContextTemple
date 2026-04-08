# ContextTemple Architecture

Current release target in this document: `1.1.0`

## Mission

Create a memory layer for existing LLM agents that improves perceived intelligence, not just retrieval depth.

That requires more than storing text. The system must improve:

- behavior selection
- context selection
- repeat error avoidance
- user alignment
- factual continuity

## Core thesis

The strongest architecture is not a single memory store.

It is a layered system:

```text
┌────────────────────────────────────────────────────────────┐
│ Layer 1. Behavioral Memory                                 │
│ - user preferences                                         │
│ - workflow rules                                           │
│ - anti-pattern guards                                      │
│ - tone calibration                                         │
└────────────────────────────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────┐
│ Layer 2. Episodic Memory                                   │
│ - decisions, facts, prior exchanges, notable artifacts     │
│ - searchable at runtime                                    │
│ - scoped by project and source                             │
└────────────────────────────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────┐
│ Layer 3. Consolidation                                     │
│ - repeated corrections become durable rules                │
│ - cross-project rules are promoted global                  │
│ - retrieval feedback updates memory salience               │
└────────────────────────────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────┐
│ Layer 4. Integration                                        │
│ - startup prompt synthesis                                 │
│ - HTTP API                                                  │
│ - future MCP interface                                     │
└────────────────────────────────────────────────────────────┘
```

## Why this is stronger than pure RAG

Pure RAG improves factual recall but does not reliably change behavior.

ContextTemple treats memory as two different products:

1. **Behavioral memory**
   The model should stop making the same mistake twice.

2. **Episodic memory**
   The model should be able to recall what happened, what was decided, and what matters now.

Perceived intelligence emerges when both work together.

## Implemented data model

### Observations

Fresh behavioral signals captured from user corrections.

Fields:

- `dimension`: `guard | style | workflow | preference | failure`
- `statement`: normalized correction or rule
- `evidence`: optional raw signal
- `confidence`: confidence from `0.1` to `1.0`
- `project`: optional project scope
- `processedAt`: null until consolidated

### Behavioral rules

Durable constraints produced by consolidation.

Fields:

- `scope`: `global | project`
- `status`: `active | retired`
- `fingerprint`: normalized semantic key
- `weight`: recency and reinforcement adjusted strength
- `evidenceCount`: number of supporting observations
- `firstSeen` / `lastSeen`
- `sourceObservationIds`

### Episodic memories

Retrievable facts and decisions.

Fields:

- `content`
- `summary`
- `tags`
- `keywords`
- `project`
- `source`
- `salience`
- `accessCount`
- `lastAccessedAt`

### Retrieval events

Feedback loop for whether retrievals were useful.

Fields:

- `query`
- `memoryId`
- `score`
- `accepted`

## Retrieval strategy

Current retrieval is deterministic and local-first, but now uses a hybrid ranking path.

Score components:

- lexical overlap
- semantic vector similarity
- tag overlap
- phrase match bonus
- recency bonus
- salience bonus
- reranking over the top candidate set

The current semantic layer supports both the local hashed fallback and stronger learned embedding providers through a shared embedding abstraction.

Additional capabilities now present:

- OpenAI-compatible embedding endpoints
- llama.cpp-compatible embedding endpoints
- active forgetting driven by usefulness feedback

## Current evaluation surface

ContextTemple now includes a committed retrieval benchmark dataset and scoring script.

Current capabilities:

- lexical-only baseline evaluation
- hybrid retrieval evaluation
- `Recall@K`, `MRR`, and `nDCG@K` reporting
- reproducible fixture-backed benchmark runs from the CLI

## Current runtime surface

ContextTemple now includes a runtime orchestration layer.

Current capabilities:

- session bootstrap planning
- retrieval policy for live turns
- runtime writeback for observations and outcomes
- llama.cpp bridge using an OpenAI-compatible chat endpoint

## Current lifecycle surface

ContextTemple now tracks lifecycle conflicts instead of assuming every stored rule and memory can stay active forever.

Current capabilities:

- rule conflict detection and conflict records
- reactivation of rules when open conflicts clear
- memory supersession when newer same-source statements replace older ones
- memory conflict detection for incompatible active memories
- operator resolution flows for rule conflicts
- operator resolution flows for memory conflicts
- candidate review states before promotion
- semantic clustering for review queues

## Current safety surface

Current capabilities:

- SQLite snapshot export
- SQLite snapshot import
- project-scoped purge
- provenance on transcripts, candidates, promotions, rules, and memories

## Consolidation strategy

Behavioral consolidation follows a simple but effective lifecycle:

```text
fresh observation
     ↓
match existing rule by fingerprint or token similarity
     ↓
update weight and evidence count
     ↓
if seen in multiple projects → promote to global
     ↓
if weight decays too low → retire
```

The important property is that behavior gets more durable only when reinforced.

## Startup context synthesis

ContextTemple generates a compact startup context with three sections:

1. operating protocol
2. durable behavioral rules
3. relevant episodic memory

This is the session-start payload for an agent.

## Current integration surface

- Bun CLI
- Hono HTTP API
- MCP server over stdio
- llama.cpp bridge over OpenAI-compatible chat completions

## Current ingestion surface

ContextTemple now supports canonical transcript ingestion as the first replayable substrate for future extraction.

Current capabilities:

- transcript parsing with auto-detection
- persisted transcript source records
- persisted canonical transcript events
- idempotent re-ingestion by checksum and project scope
- CLI preview and event inspection
- persisted extraction runs and extraction candidates
- heuristic extraction of decisions, observations, facts, and outcomes
- persisted promotion runs
- promotion of extracted observations into behavioral memory
- promotion of extracted decisions, facts, and outcomes into episodic memory

## Remaining optional expansion

The originally planned core surface is now implemented.

Future expansion is optional and may include:

- stronger learned embedding models by default
- richer multi-user operator workflows
- distributed sync and cloud-backed storage

### Memory quality loop

Track:

- which retrieved memories were actually useful
- which startup rules reduced user corrections
- which rules went stale and should expire

## Design constraints

- local-first
- deterministic baseline
- no mandatory external model dependency
- behavioral and episodic memory kept separate until synthesis
- compact enough for startup context injection

## Repository layout

```text
src/
  behavioral.ts     behavioral observation and rule consolidation
  episodic.ts       memory storage and retrieval
  context.ts        startup context synthesis
  consolidation.ts  orchestration of learning cycles
  http.ts           Hono API
  cli.ts            Bun CLI
  db.ts             database bootstrap and access
  schema.ts         Drizzle schema
  ingest/
    normalize.ts    transcript parser registry and auto-detection
    transcripts.ts  transcript persistence and replay access
    events.ts       canonical event rendering and bounds
```

## Implementation note

The first release focuses on the minimum layer that is already useful:

- you can store memory
- you can learn behavioral rules
- you can retrieve relevant prior context
- you can synthesize startup context for an agent

That gives the project a working foundation before adding embeddings, MCP, and transcript mining.
