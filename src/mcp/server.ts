import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { recordObservation } from "../behavioral.ts";
import { buildStartupContext } from "../context.ts";
import { openTempleDatabase } from "../db.ts";
import { rememberEpisode, searchEpisodes } from "../episodic.ts";
import { ValidationError } from "../errors.ts";
import { clusterExtractionCandidates, extractTranscriptCandidates, reviewExtractionCandidate } from "../extract/candidates.ts";
import { importTranscript } from "../ingest/transcripts.ts";
import { listMemoryConflictRecords, listRuleConflictRecords, resolveMemoryConflict, resolveRuleConflict } from "../lifecycle/conflicts.ts";
import { runActiveForgetting } from "../maintenance/forget.ts";
import { promoteExtractionRun } from "../promote/candidates.ts";
import { completeRuntimeTurn, prepareRuntimeTurn } from "../runtime/orchestrator.ts";
import { getTempleStatus } from "../status.ts";
import { behavioralDimensions } from "../types.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version: string };

const runtimeMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1),
  name: z.string().optional().nullable(),
});

const toolSchemas = {
  contexttemple_status: z.object({
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_search_memory: z.object({
    query: z.string().min(1),
    project: z.string().optional().nullable(),
    limit: z.number().int().positive().optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_startup_context: z.object({
    query: z.string().optional().nullable(),
    project: z.string().optional().nullable(),
    maxRules: z.number().int().positive().optional(),
    maxMemories: z.number().int().positive().optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_record_observation: z.object({
    dimension: z.enum(behavioralDimensions),
    statement: z.string().min(1),
    project: z.string().optional().nullable(),
    evidence: z.string().optional().nullable(),
    confidence: z.number().min(0.1).max(1).optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_remember_episode: z.object({
    content: z.string().min(1),
    project: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    tags: z.array(z.string()).optional(),
    salience: z.number().min(1).max(10).optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_import_transcript: z.object({
    filePath: z.string().min(1),
    project: z.string().optional().nullable(),
    sourceLabel: z.string().optional().nullable(),
    format: z.enum(["auto", "jsonl", "chat-json", "prefixed-text"]).optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_extract_transcript: z.object({
    transcriptId: z.string().min(1),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_promote_extraction: z.object({
    extractionRunId: z.string().min(1),
    requireApproval: z.boolean().optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_review_candidate: z.object({
    candidateId: z.string().min(1),
    status: z.enum(["approve", "reject", "reset"]),
    note: z.string().optional().nullable(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_candidate_clusters: z.object({
    project: z.string().optional().nullable(),
    extractionRunId: z.string().optional().nullable(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_runtime_plan: z.object({
    messages: z.array(runtimeMessageSchema).min(1),
    project: z.string().optional().nullable(),
    maxPromptTokens: z.number().int().positive().optional(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_runtime_complete: z.object({
    messages: z.array(runtimeMessageSchema).min(1),
    assistantMessage: z.string().optional().nullable(),
    sessionId: z.string().optional().nullable(),
    project: z.string().optional().nullable(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_list_rule_conflicts: z.object({
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_list_memory_conflicts: z.object({
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_resolve_rule_conflict: z.object({
    conflictId: z.string().min(1),
    winner: z.enum(["left", "right", "both"]),
    note: z.string().optional().nullable(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_resolve_memory_conflict: z.object({
    conflictId: z.string().min(1),
    winner: z.enum(["left", "right", "both"]),
    note: z.string().optional().nullable(),
    homeDir: z.string().optional().nullable(),
  }),
  contexttemple_run_active_forgetting: z.object({
    project: z.string().optional().nullable(),
    usefulnessThreshold: z.number().min(0).max(1).optional(),
    maxAgeDays: z.number().int().positive().optional(),
    dryRun: z.boolean().optional(),
    homeDir: z.string().optional().nullable(),
  }),
} as const;

export const contextTempleMcpTools = [
  {
    name: "contexttemple_status",
    description: "Inspect ContextTemple counts for memory, extraction, promotion, and conflict records.",
    schema: toolSchemas.contexttemple_status,
  },
  {
    name: "contexttemple_search_memory",
    description: "Search episodic memory using ContextTemple's hybrid lexical plus semantic retrieval stack.",
    schema: toolSchemas.contexttemple_search_memory,
  },
  {
    name: "contexttemple_startup_context",
    description: "Synthesize startup context that combines behavioral rules with relevant episodic memory.",
    schema: toolSchemas.contexttemple_startup_context,
  },
  {
    name: "contexttemple_record_observation",
    description: "Write a behavioral observation into ContextTemple.",
    schema: toolSchemas.contexttemple_record_observation,
  },
  {
    name: "contexttemple_remember_episode",
    description: "Store an episodic memory in ContextTemple.",
    schema: toolSchemas.contexttemple_remember_episode,
  },
  {
    name: "contexttemple_import_transcript",
    description: "Import a transcript into ContextTemple's canonical event store.",
    schema: toolSchemas.contexttemple_import_transcript,
  },
  {
    name: "contexttemple_extract_transcript",
    description: "Extract structured candidates from an imported transcript.",
    schema: toolSchemas.contexttemple_extract_transcript,
  },
  {
    name: "contexttemple_promote_extraction",
    description: "Promote extracted candidates into durable observations and episodic memories.",
    schema: toolSchemas.contexttemple_promote_extraction,
  },
  {
    name: "contexttemple_review_candidate",
    description: "Approve, reject, or reset an extracted candidate before promotion.",
    schema: toolSchemas.contexttemple_review_candidate,
  },
  {
    name: "contexttemple_candidate_clusters",
    description: "Cluster pending extracted candidates by semantic similarity for operator review.",
    schema: toolSchemas.contexttemple_candidate_clusters,
  },
  {
    name: "contexttemple_runtime_plan",
    description: "Prepare a runtime turn plan including retrieval decisions and system messages.",
    schema: toolSchemas.contexttemple_runtime_plan,
  },
  {
    name: "contexttemple_runtime_complete",
    description: "Complete a runtime turn by writing back observations and durable outcomes.",
    schema: toolSchemas.contexttemple_runtime_complete,
  },
  {
    name: "contexttemple_list_rule_conflicts",
    description: "List currently detected behavioral rule conflicts.",
    schema: toolSchemas.contexttemple_list_rule_conflicts,
  },
  {
    name: "contexttemple_list_memory_conflicts",
    description: "List currently detected episodic memory conflicts.",
    schema: toolSchemas.contexttemple_list_memory_conflicts,
  },
  {
    name: "contexttemple_resolve_rule_conflict",
    description: "Resolve a behavioral rule conflict by choosing the winning side.",
    schema: toolSchemas.contexttemple_resolve_rule_conflict,
  },
  {
    name: "contexttemple_resolve_memory_conflict",
    description: "Resolve an episodic memory conflict by choosing the winning side.",
    schema: toolSchemas.contexttemple_resolve_memory_conflict,
  },
  {
    name: "contexttemple_run_active_forgetting",
    description: "Archive low-value active memories using usefulness feedback and age thresholds.",
    schema: toolSchemas.contexttemple_run_active_forgetting,
  },
] as const;

export function createContextTempleMcpServer() {
  const server = new McpServer(
    {
      name: "contexttemple",
      version: packageJson.version,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use ContextTemple to inspect memory state, search episodic memory, generate startup context, write observations and memories, ingest transcripts, run extraction/promotion, and plan runtime turns.",
    },
  );

  for (const tool of contextTempleMcpTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args: unknown) => formatMcpToolResult(await executeContextTempleMcpTool({ name: tool.name, args })),
    );
  }

  return server;
}

export async function startContextTempleMcpServer() {
  const server = createContextTempleMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export async function executeContextTempleMcpTool({
  name,
  args,
}: {
  name: (typeof contextTempleMcpTools)[number]["name"];
  args: unknown;
}) {
  const parsed = toolSchemas[name].safeParse(args ?? {});
  if (!parsed.success) {
    return new ValidationError({
      field: name,
      reason: parsed.error.issues[0]?.message ?? "invalid MCP tool arguments",
    });
  }

  const input = parsed.data as Record<string, unknown> & { homeDir?: string | null };
  const temple = await openTempleDatabase({ homeDir: input.homeDir ?? undefined });
  if (temple instanceof Error) return temple;

  try {
    switch (name) {
      case "contexttemple_status":
        return await getTempleStatus({ temple });
      case "contexttemple_search_memory":
        return await searchEpisodes({
          temple,
          query: input.query as string,
          project: (input.project as string | null | undefined) ?? null,
          limit: input.limit as number | undefined,
        });
      case "contexttemple_startup_context":
        return await buildStartupContext({
          temple,
          query: (input.query as string | null | undefined) ?? null,
          project: (input.project as string | null | undefined) ?? null,
          maxRules: input.maxRules as number | undefined,
          maxMemories: input.maxMemories as number | undefined,
        });
      case "contexttemple_record_observation":
        return await recordObservation({
          temple,
          input: {
            dimension: input.dimension as (typeof behavioralDimensions)[number],
            statement: input.statement as string,
            project: (input.project as string | null | undefined) ?? null,
            evidence: (input.evidence as string | null | undefined) ?? null,
            confidence: input.confidence as number | undefined,
          },
        });
      case "contexttemple_remember_episode":
        return await rememberEpisode({
          temple,
          input: {
            content: input.content as string,
            project: (input.project as string | null | undefined) ?? null,
            source: (input.source as string | null | undefined) ?? null,
            tags: input.tags as string[] | undefined,
            salience: input.salience as number | undefined,
          },
        });
      case "contexttemple_import_transcript":
        return await importTranscript({
          temple,
          filePath: input.filePath as string,
          project: (input.project as string | null | undefined) ?? null,
          sourceLabel: (input.sourceLabel as string | null | undefined) ?? null,
          format: input.format as "auto" | "jsonl" | "chat-json" | "prefixed-text" | undefined,
        });
      case "contexttemple_extract_transcript":
        return await extractTranscriptCandidates({ temple, transcriptId: input.transcriptId as string });
      case "contexttemple_promote_extraction":
        return await promoteExtractionRun({
          temple,
          extractionRunId: input.extractionRunId as string,
          requireApproval: Boolean(input.requireApproval),
        });
      case "contexttemple_review_candidate":
        return await reviewExtractionCandidate({
          temple,
          candidateId: input.candidateId as string,
          status: input.status as "approve" | "reject" | "reset",
          note: (input.note as string | null | undefined) ?? null,
        });
      case "contexttemple_candidate_clusters":
        return await clusterExtractionCandidates({
          temple,
          project: (input.project as string | null | undefined) ?? null,
          extractionRunId: (input.extractionRunId as string | null | undefined) ?? null,
        });
      case "contexttemple_runtime_plan":
        return await prepareRuntimeTurn({
          temple,
          project: (input.project as string | null | undefined) ?? null,
          messages: input.messages as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; name?: string | null }>,
          maxPromptTokens: input.maxPromptTokens as number | undefined,
        });
      case "contexttemple_runtime_complete":
        return await completeRuntimeTurn({
          temple,
          project: (input.project as string | null | undefined) ?? null,
          sessionId: (input.sessionId as string | null | undefined) ?? null,
          messages: input.messages as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; name?: string | null }>,
          assistantMessage: (input.assistantMessage as string | null | undefined) ?? null,
        });
      case "contexttemple_list_rule_conflicts":
        return await listRuleConflictRecords({ temple });
      case "contexttemple_list_memory_conflicts":
        return await listMemoryConflictRecords({ temple });
      case "contexttemple_resolve_rule_conflict":
        return await resolveRuleConflict({
          temple,
          conflictId: input.conflictId as string,
          winner: input.winner as "left" | "right" | "both",
          note: (input.note as string | null | undefined) ?? null,
        });
      case "contexttemple_resolve_memory_conflict":
        return await resolveMemoryConflict({
          temple,
          conflictId: input.conflictId as string,
          winner: input.winner as "left" | "right" | "both",
          note: (input.note as string | null | undefined) ?? null,
        });
      case "contexttemple_run_active_forgetting":
        return await runActiveForgetting({
          temple,
          project: (input.project as string | null | undefined) ?? null,
          usefulnessThreshold: input.usefulnessThreshold as number | undefined,
          maxAgeDays: input.maxAgeDays as number | undefined,
          dryRun: Boolean(input.dryRun),
        });
    }
  } finally {
    await temple.close();
  }
}

function formatMcpToolResult(result: unknown) {
  const isError = result instanceof Error;
  const value = isError ? { error: result.message } : result;
  const structuredContent = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent,
  };
}
