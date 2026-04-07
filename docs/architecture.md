# ContextTemple Architecture

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

Current retrieval is deterministic and local-first.

Score components:

- keyword overlap
- summary overlap
- tag overlap
- phrase match bonus
- recency bonus
- salience bonus

This keeps the first implementation usable without needing embeddings or a paid API.

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

## Planned next layers

### Embedding-backed consolidation

Use semantic clustering to merge observations that are equivalent but lexically different.

### MCP server

Expose search, wake, feedback, and observation recording as direct agent tools.

### Automatic transcript ingestion

Turn agent transcripts into both episodic memories and behavioral observations.

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
```

## Implementation note

The first release focuses on the minimum layer that is already useful:

- you can store memory
- you can learn behavioral rules
- you can retrieve relevant prior context
- you can synthesize startup context for an agent

That gives the project a working foundation before adding embeddings, MCP, and transcript mining.
