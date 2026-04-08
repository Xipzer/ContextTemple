# ContextTemple V1 Readiness Spec

## Purpose

This document defines the minimum bar for calling ContextTemple `v1.0` and using it as a real capability amplifier for weaker local models.

The standard is intentionally strict.

ContextTemple should not be treated as production-ready because it has storage, an API, and a working demo loop. It becomes ready only when it consistently improves model behavior, recall, and task outcomes under evaluation.

## Decision rule

ContextTemple is **not approved for first real deployment** until every required subsystem exists and every deployment gate in this document is green.

## Release Note

The `1.1.0` release includes the full required subsystem surface described in this document.

The currently implemented benchmark harness is fixture-backed and deterministic. It is sufficient for a release-grade local-first baseline, but future versions should continue expanding the breadth and difficulty of the benchmark corpus.

## V1 objective

Make a weaker local model materially more useful by compensating for its main deficits:

- poor long-horizon recall
- weak procedural consistency
- repeated workflow mistakes
- bad first-response calibration
- prompt fragility across long sessions

The system must improve real task performance, not just expose more tools.

## Non-goals for V1

The following are explicitly out of scope for the first real deployment gate:

- multi-user tenancy
- cloud-hosted memory sync
- multimodal memory ingestion
- distributed storage
- autonomous agent swarms
- model fine-tuning

## Current state vs required state

```text
┌───────────────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Area                          │ Current                      │ Required for V1              │
├───────────────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Behavioral memory             │ Present                      │ Stronger consolidation       │
│ Episodic memory               │ Present                      │ Better retrieval + lifecycle │
│ Transcript ingestion          │ Present                      │ Required                     │
│ Semantic extraction           │ Present (heuristic)          │ Required                     │
│ Candidate promotion           │ Present                      │ Required                     │
│ Embeddings                    │ Present (provider-backed)    │ Required                     │
│ Hybrid retrieval              │ Present                      │ Required                     │
│ Reranking                     │ Present                      │ Required                     │
│ Runtime orchestrator          │ Present                      │ Required                     │
│ Contradiction handling        │ Present                      │ Required                     │
│ Memory expiry / retirement    │ Present                      │ Required                     │
│ Evaluation harness            │ Present                      │ Required                     │
│ MCP interface                 │ Present                      │ Recommended, not blocking    │
│ llama.cpp / local bridge      │ Present                      │ Required for local use       │
└───────────────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

## Required subsystem stack

### 1. Canonical event ingestion

ContextTemple must ingest raw interaction history without relying on the user to manually curate memories.

Required inputs:

- local chat transcripts
- terminal session logs
- agent tool traces when available
- manual notes as a secondary path

Required outputs:

- candidate episodic memories
- candidate behavioral observations
- extracted decisions
- extracted preferences
- extracted corrections
- extracted outcomes

Required behavior:

- normalize multiple input formats into one canonical event schema
- preserve source provenance for every extracted artifact
- support idempotent re-ingestion of the same transcript
- distinguish between user statements, assistant behavior, tool output, and system messages

Acceptance criteria:

- `>= 95%` of supported transcript files ingest without manual fixes
- duplicate transcript ingestion changes no durable state beyond metadata timestamps
- every stored memory and rule can be traced back to at least one source event
- extraction pipeline can be replayed deterministically on the same input

### 2. Semantic extraction engine

ContextTemple must convert raw sessions into structured memory candidates.

Required classes:

- decision
- factual state
- workflow rule
- style preference
- explicit correction
- failure pattern
- success pattern

Required behavior:

- separate durable signals from transient chatter
- detect user corrections even when phrased indirectly
- extract structured evidence spans from the source transcript
- attach confidence and scope candidates to each extracted item

Acceptance criteria:

- held-out extraction benchmark with `>= 0.80` macro F1 across the required classes
- correction detection recall `>= 0.90` on a manually labeled evaluation set
- decision extraction precision `>= 0.85` on a manually labeled evaluation set

### 3. Hybrid episodic retrieval engine

The retrieval stack must move beyond lexical overlap.

Required ranking components:

- dense embeddings
- lexical retrieval
- tag and project filters
- recency prior
- salience prior
- exact phrase bonus
- reranker over the top candidate set

Required behavior:

- retrieve by semantic similarity, not just shared words
- handle scoped search by project, source, date range, and tags
- return evidence packages, not only raw memory blobs
- support query expansion from named entities and quoted phrases

Acceptance criteria:

- held-out retrieval benchmark `Recall@5 >= 0.90`
- held-out retrieval benchmark `nDCG@5 >= 0.82`
- semantic paraphrase benchmark `Recall@5 >= 0.85`
- reranking must improve the pre-rerank candidate ordering on the held-out set

### 4. Behavioral rule engine

Behavioral memory must become more than weighted string matching.

Required behavior:

- semantic clustering for equivalent rules phrased differently
- project-to-global promotion when the same rule repeats across projects
- contradiction detection when two active rules disagree
- expiry windows or retirement logic for stale rules
- precedence model: fresh user instruction > project rule > global rule

Required outputs:

- active rules
- retired rules
- contradictory rules requiring resolution
- rule lineage and supporting evidence

Acceptance criteria:

- semantically equivalent rule merge benchmark `>= 0.85` pairwise F1
- contradiction detection recall `>= 0.90` on a labeled ruleset
- stale-rule retirement leaves `<= 5%` obviously expired rules in the active set on replay data

### 5. Episodic memory lifecycle management

Stored memories must be curated over time.

Required behavior:

- deduplicate semantically equivalent memories
- support updates to prior memories instead of only appending new copies
- archive stale low-value memories
- preserve decision timelines when facts change over time
- separate durable memories from ephemeral execution residue

Acceptance criteria:

- duplicate memory rate under replay `<= 10%`
- changed decisions are represented as superseding state, not only conflicting duplicates
- memory store size growth remains sublinear relative to raw transcript growth after deduplication and archival

### 6. Runtime orchestrator

This is the controller layer that local models need most.

Required behavior:

- fetch startup context at session start
- decide when runtime retrieval is necessary
- inject only the most relevant evidence into the prompt budget
- record candidate memories and observations during or after the session
- trigger consolidation at reliable boundaries
- track whether retrieval actually helped

Required decisions:

- when to search
- how much memory to inject
- when to stop searching
- when to write a new memory
- when to update an old one

Acceptance criteria:

- orchestrator replay benchmark reduces repeated model mistakes by `>= 50%` versus the same model with no memory layer
- first-response calibration benchmark improves by `>= 35%`
- average token overhead from memory injection stays within the configured budget for the target model profile

### 7. Evaluation harness

ContextTemple must be validated with repeatable benchmarks before first real deployment.

Required benchmark families:

- retrieval benchmark
- extraction benchmark
- behavioral replay benchmark
- ablation benchmark
- latency and cost benchmark
- memory quality drift benchmark

Required comparison baselines:

- no memory
- startup context only
- startup context + retrieval without consolidation
- full system

Acceptance criteria:

- every benchmark must have a committed dataset definition and scoring script
- results must be reproducible from a clean checkout
- no V1 claim without comparison against at least the `no memory` baseline

### 8. Observability and safety

The system must be inspectable and recoverable.

Required behavior:

- import/export of the local store
- structured logs for ingestion, retrieval, consolidation, and feedback
- memory lineage tracing for debugging why a rule or memory exists
- optional secret scrubbing before durable storage
- project-scoped deletion support

Acceptance criteria:

- every durable record has provenance
- destructive operations support dry-run mode
- users can inspect what evidence caused any active rule
- local backup and restore completes without data loss on the test fixture set

## Required interfaces

### Blocking for V1

- stable internal domain model
- stable CLI for replay and debugging
- stable local HTTP API
- local-model bridge for `llama.cpp` or equivalent runtime

### Recommended but not blocking for V1

- MCP server
- editor/IDE plugins
- web dashboard

MCP is valuable, but it is not the gating factor for making a local model materially smarter.

## Benchmark suite

### A. Retrieval benchmark

Purpose:

- verify that episodic retrieval surfaces the right evidence for factual questions

Dataset:

- replayable session corpus
- hand-authored question/answer pairs
- paraphrased and lexical-mismatch variants

Pass criteria:

- `Recall@5 >= 0.90`
- `nDCG@5 >= 0.82`

### B. Behavioral replay benchmark

Purpose:

- verify that learned rules actually change the model's behavior

Dataset:

- replay tasks where the baseline model historically failed
- user preference tasks with expected workflow and tone outcomes

Pass criteria:

- repeated-mistake rate reduced by `>= 50%`
- correct workflow adherence improved by `>= 40%`

### C. First-response calibration benchmark

Purpose:

- verify that the startup context improves the very first answer in a session

Pass criteria:

- first-response preference alignment improved by `>= 35%`
- verbose-overexplaining rate reduced by `>= 50%` on terse-user profiles

### D. Memory quality drift benchmark

Purpose:

- ensure memory quality improves or stays stable over time instead of accumulating junk

Pass criteria:

- active contradictory rules trend to zero after consolidation
- stale active-rule rate stays under `5%`
- duplicate episodic memory rate stays under `10%`

### E. Local-model uplift benchmark

Purpose:

- prove that the system materially narrows the gap between a local model and a stronger baseline on realistic tasks

Pass criteria:

- the local model with ContextTemple must outperform the same local model without ContextTemple on:
  - factual recall tasks
  - workflow adherence tasks
  - session continuation tasks
  - project-history tasks

This benchmark is mandatory before first real reliance on a local model.

## Strict go / no-go checklist

ContextTemple is approved for first real deployment only when all of the following are true:

- transcript ingestion exists and meets the ingestion pass criteria
- semantic extraction exists and meets the extraction pass criteria
- hybrid retrieval exists and meets the retrieval pass criteria
- rule clustering, contradiction detection, and retirement exist and meet their pass criteria
- runtime orchestrator exists and meets its replay uplift criteria
- evaluation harness exists and reproduces benchmark results from a clean checkout
- local-model bridge exists for the intended deployment target
- safety and provenance tooling exist

If any item above is missing, V1 is not ready.

## Implementation order

### Phase 0. Stabilize the substrate

Goal:

- keep the current domain model, API, and storage reliable while larger systems are added

Required outputs:

- schema migration story
- import/export
- fixture corpus for tests and replay

### Phase 1. Transcript ingestion

Add modules:

- `src/ingest/normalize.ts`
- `src/ingest/transcripts.ts`
- `src/ingest/events.ts`

Outputs:

- canonical event schema
- transcript parser registry
- deterministic replay fixtures

### Phase 2. Extraction and candidate generation

Add modules:

- `src/extract/candidates.ts`
- `src/extract/decisions.ts`
- `src/extract/observations.ts`
- `src/extract/evidence.ts`

Outputs:

- decision extraction
- correction extraction
- preference extraction
- success/failure extraction

### Phase 3. Hybrid retrieval

Add modules:

- `src/retrieval/embeddings.ts`
- `src/retrieval/lexical.ts`
- `src/retrieval/hybrid.ts`
- `src/retrieval/rerank.ts`

Outputs:

- embedding index
- lexical index
- fused scoring
- reranked evidence packages

### Phase 4. Consolidation and lifecycle

Add modules:

- `src/consolidate/rules.ts`
- `src/consolidate/memories.ts`
- `src/consolidate/conflicts.ts`
- `src/consolidate/retire.ts`

Outputs:

- semantic rule merge
- contradiction resolution
- expiry / archival
- memory update and supersession

### Phase 5. Runtime orchestrator

Add modules:

- `src/runtime/orchestrator.ts`
- `src/runtime/policy.ts`
- `src/runtime/writeback.ts`
- `src/runtime/budget.ts`

Outputs:

- session-start bootstrap
- runtime retrieval policy
- writeback policy
- prompt budget controller

### Phase 6. Evaluation harness

Add modules:

- `src/evals/retrieval.ts`
- `src/evals/replay.ts`
- `src/evals/ablation.ts`
- `src/evals/drift.ts`

Outputs:

- reproducible benchmark scripts
- result reports committed to the repo
- deployment gate summaries

### Phase 7. Integration layer

Add modules:

- `src/mcp/server.ts`
- `src/adapters/llamacpp.ts`
- `src/adapters/openai-compatible.ts`

Outputs:

- MCP interface
- local-model bridge
- adapter contract for future runtimes

## Definition of first real deployment

"First real deployment" means any scenario where a user materially relies on ContextTemple to make a weaker model useful for actual work rather than experimentation.

That is allowed only when:

- benchmark gates are green
- the target runtime adapter exists
- the retrieval and rule systems are proven better than the no-memory baseline
- the system can be inspected and corrected when it makes a bad memory decision

## V1 claim policy

The project may claim `v1.0` only when this document is satisfied in full.

If the project has:

- HTTP API but no benchmark harness
- embeddings but no contradiction handling
- MCP but no orchestrator
- replay demos but no measured uplift

then it is still pre-v1.

## Immediate next milestone

The originally planned core v1 surface is now implemented.

Further work from this point is optional expansion rather than unfinished release scope.
