# Changelog

## 1.2.0

- added agent instructions generator for CLAUDE.md and AGENTS.md-compatible output with embedded tool-calling policy
- added Kimaki/OpenCode session transcript adapter with single-session and batch directory ingestion
- added post-session consolidation hook that ingests a session, consolidates, and regenerates agent instructions
- added frontier eval benchmark for MCP tool-calling behavior and instructions generation quality
- expanded MCP tool surface with `contexttemple_generate_instructions` (18 tools total)
- added HTTP endpoint `GET /api/frontier/instructions` for programmatic instructions generation
- added CLI commands: `frontier instructions`, `frontier ingest-session`, `frontier batch-ingest`, `frontier post-session`, `frontier update-instructions`, `eval frontier`
- the system now works equally well for local models (via bridge) and frontier agents (via MCP + instructions)

## 1.1.0

- added provider-backed embeddings with OpenAI-compatible and llama.cpp-compatible support
- added candidate review flows, semantic clustering, active forgetting, and explicit conflict resolution
- added streamed llama.cpp bridge support and expanded MCP tool surface
- removed the remaining active roadmap items from the original release plan

## 1.0.0

- built the full ContextTemple v1 surface for local-first LLM memory orchestration
- added transcript ingestion, extraction, promotion, runtime planning, writeback, and lifecycle conflict handling
- added hybrid lexical plus semantic retrieval with reranking and fixture-backed benchmarks
- added behavioral replay, first-response calibration, and composite uplift evals
- added llama.cpp bridge, MCP server, and backup/restore/project-purge tooling
