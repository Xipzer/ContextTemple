import * as errore from "errore";
import { Hono, type Context as HonoContext } from "hono";
import { z } from "zod";

import { buildStartupContext } from "./context.ts";
import type { TempleDatabase } from "./db.ts";
import { recordRetrievalFeedback, rememberEpisode, searchEpisodes } from "./episodic.ts";
import { ServerStartError, ValidationError } from "./errors.ts";
import { clusterExtractionCandidates, extractTranscriptCandidates, listExtractionCandidates, listExtractionRuns, reviewExtractionCandidate } from "./extract/candidates.ts";
import { listMemoryConflictRecords, listRuleConflictRecords, resolveMemoryConflict, resolveRuleConflict } from "./lifecycle/conflicts.ts";
import { runActiveForgetting } from "./maintenance/forget.ts";
import { listPromotionRuns, promoteExtractionRun } from "./promote/candidates.ts";
import { runConsolidationCycle } from "./consolidation.ts";
import { recordObservation } from "./behavioral.ts";
import { completeRuntimeTurn, prepareRuntimeTurn } from "./runtime/orchestrator.ts";
import { getTempleStatus } from "./status.ts";
import { behavioralDimensions } from "./types.ts";

const rememberSchema = z.object({
  project: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  salience: z.number().min(1).max(10).optional(),
});

const observationSchema = z.object({
  project: z.string().optional().nullable(),
  dimension: z.enum(behavioralDimensions),
  statement: z.string().min(1),
  evidence: z.string().optional().nullable(),
  confidence: z.number().min(0.1).max(1).optional(),
});

const feedbackSchema = z.object({
  retrievalId: z.string().min(1),
  accepted: z.boolean(),
});

const candidateReviewSchema = z.object({
  status: z.enum(["approve", "reject", "reset"]),
  note: z.string().optional().nullable(),
});

const conflictResolutionSchema = z.object({
  winner: z.enum(["left", "right", "both"]),
  note: z.string().optional().nullable(),
});

const forgettingSchema = z.object({
  project: z.string().optional().nullable(),
  usefulnessThreshold: z.number().min(0).max(1).optional(),
  maxAgeDays: z.number().int().positive().optional(),
  dryRun: z.boolean().optional(),
});

const runtimeMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1),
  name: z.string().optional().nullable(),
});

const runtimePlanSchema = z.object({
  project: z.string().optional().nullable(),
  maxPromptTokens: z.number().int().positive().optional(),
  messages: z.array(runtimeMessageSchema).min(1),
});

const runtimeCompleteSchema = z.object({
  project: z.string().optional().nullable(),
  sessionId: z.string().optional().nullable(),
  assistantMessage: z.string().optional().nullable(),
  messages: z.array(runtimeMessageSchema).min(1),
});

export function createTempleApp({ temple }: { temple: TempleDatabase }) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/stats", async (c) => {
    const status = await getTempleStatus({ temple });
    if (status instanceof Error) return errorResponse(c, status);
    return c.json(status);
  });

  app.post("/api/memories", async (c) => {
    const body = await parseJsonBody({ c, schema: rememberSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const memory = await rememberEpisode({ temple, input: body });
    if (memory instanceof Error) return errorResponse(c, memory);
    return c.json(memory, 201);
  });

  app.post("/api/observations", async (c) => {
    const body = await parseJsonBody({ c, schema: observationSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const observation = await recordObservation({ temple, input: body });
    if (observation instanceof Error) return errorResponse(c, observation);
    return c.json(observation, 201);
  });

  app.post("/api/consolidate", async (c) => {
    const report = await runConsolidationCycle({ temple, project: c.req.query("project") ?? null });
    if (report instanceof Error) return errorResponse(c, report);
    return c.json(report);
  });

  app.post("/api/extract/transcripts/:transcriptId", async (c) => {
    const transcriptId = c.req.param("transcriptId");
    const result = await extractTranscriptCandidates({ temple, transcriptId });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.get("/api/extract/runs", async (c) => {
    const runs = await listExtractionRuns({
      temple,
      project: c.req.query("project") ?? null,
      transcriptId: c.req.query("transcriptId") ?? null,
      limit: Number(c.req.query("limit") ?? 20),
    });
    if (runs instanceof Error) return errorResponse(c, runs);
    return c.json(runs);
  });

  app.get("/api/extract/candidates", async (c) => {
    const candidates = await listExtractionCandidates({
      temple,
      transcriptId: c.req.query("transcriptId") ?? null,
      extractionRunId: c.req.query("extractionRunId") ?? null,
      reviewStatus: (c.req.query("reviewStatus") as "pending" | "approved" | "rejected" | "promoted" | null) ?? null,
    });
    if (candidates instanceof Error) return errorResponse(c, candidates);
    return c.json(candidates);
  });

  app.post("/api/review/candidates/:candidateId", async (c) => {
    const body = await parseJsonBody({ c, schema: candidateReviewSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const result = await reviewExtractionCandidate({
      temple,
      candidateId: c.req.param("candidateId"),
      status: body.status,
      note: body.note,
    });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result);
  });

  app.get("/api/review/clusters", async (c) => {
    const clusters = await clusterExtractionCandidates({
      temple,
      project: c.req.query("project") ?? null,
      extractionRunId: c.req.query("extractionRunId") ?? null,
    });
    if (clusters instanceof Error) return errorResponse(c, clusters);
    return c.json(clusters);
  });

  app.post("/api/promote/extractions/:extractionRunId", async (c) => {
    const extractionRunId = c.req.param("extractionRunId");
    const result = await promoteExtractionRun({ temple, extractionRunId });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.get("/api/promote/runs", async (c) => {
    const runs = await listPromotionRuns({
      temple,
      project: c.req.query("project") ?? null,
      extractionRunId: c.req.query("extractionRunId") ?? null,
      limit: Number(c.req.query("limit") ?? 20),
    });
    if (runs instanceof Error) return errorResponse(c, runs);
    return c.json(runs);
  });

  app.get("/api/conflicts/rules", async (c) => {
    const conflicts = await listRuleConflictRecords({ temple });
    if (conflicts instanceof Error) return errorResponse(c, conflicts);
    return c.json(conflicts);
  });

  app.post("/api/conflicts/rules/:conflictId/resolve", async (c) => {
    const body = await parseJsonBody({ c, schema: conflictResolutionSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const result = await resolveRuleConflict({
      temple,
      conflictId: c.req.param("conflictId"),
      winner: body.winner,
      note: body.note,
    });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result);
  });

  app.get("/api/conflicts/memories", async (c) => {
    const conflicts = await listMemoryConflictRecords({ temple });
    if (conflicts instanceof Error) return errorResponse(c, conflicts);
    return c.json(conflicts);
  });

  app.post("/api/conflicts/memories/:conflictId/resolve", async (c) => {
    const body = await parseJsonBody({ c, schema: conflictResolutionSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const result = await resolveMemoryConflict({
      temple,
      conflictId: c.req.param("conflictId"),
      winner: body.winner,
      note: body.note,
    });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result);
  });

  app.post("/api/maintenance/forget", async (c) => {
    const body = await parseJsonBody({ c, schema: forgettingSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const result = await runActiveForgetting({
      temple,
      project: body.project,
      usefulnessThreshold: body.usefulnessThreshold,
      maxAgeDays: body.maxAgeDays,
      dryRun: body.dryRun,
    });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result);
  });

  app.get("/api/search", async (c) => {
    const query = c.req.query("q") ?? "";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : 5;
    const results = await searchEpisodes({
      temple,
      query,
      project: c.req.query("project") ?? null,
      limit: Number.isFinite(limit) ? limit : 5,
    });
    if (results instanceof Error) return errorResponse(c, results);
    return c.json(results);
  });

  app.post("/api/runtime/plan", async (c) => {
    const body = await parseJsonBody({ c, schema: runtimePlanSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const plan = await prepareRuntimeTurn({
      temple,
      project: body.project,
      maxPromptTokens: body.maxPromptTokens,
      messages: body.messages,
    });
    if (plan instanceof Error) return errorResponse(c, plan);
    return c.json(plan);
  });

  app.post("/api/runtime/complete", async (c) => {
    const body = await parseJsonBody({ c, schema: runtimeCompleteSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const result = await completeRuntimeTurn({
      temple,
      project: body.project,
      sessionId: body.sessionId,
      assistantMessage: body.assistantMessage,
      messages: body.messages,
    });
    if (result instanceof Error) return errorResponse(c, result);
    return c.json(result);
  });

  app.get("/api/context", async (c) => {
    const maxRulesRaw = c.req.query("maxRules");
    const maxMemoriesRaw = c.req.query("maxMemories");
    const context = await buildStartupContext({
      temple,
      project: c.req.query("project") ?? null,
      query: c.req.query("query") ?? null,
      maxRules: maxRulesRaw ? Number(maxRulesRaw) : 8,
      maxMemories: maxMemoriesRaw ? Number(maxMemoriesRaw) : 4,
    });
    if (context instanceof Error) return errorResponse(c, context);
    return c.json(context);
  });

  app.post("/api/feedback", async (c) => {
    const body = await parseJsonBody({ c, schema: feedbackSchema });
    if (body instanceof Error) return errorResponse(c, body);

    const feedback = await recordRetrievalFeedback({ temple, ...body });
    if (feedback instanceof Error) return errorResponse(c, feedback);
    return c.json(feedback);
  });

  return app;
}

export function startTempleServer({
  temple,
  port,
}: {
  temple: TempleDatabase;
  port: number;
}) {
  const app = createTempleApp({ temple });
  const server = errore.try({
    try: () => Bun.serve({ port, fetch: app.fetch }),
    catch: (cause) => new ServerStartError({ port: String(port), cause }),
  });
  if (server instanceof Error) return server;

  return { app, server };
}

async function parseJsonBody<T>({
  c,
  schema,
}: {
  c: HonoContext;
  schema: z.ZodType<T>;
}) {
  const body = await c.req.json<unknown>().catch(
    (cause: Error) => new ValidationError({ field: "body", reason: "must be valid JSON", cause }),
  );
  if (body instanceof Error) return body;

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return new ValidationError({
      field: "body",
      reason: parsed.error.issues[0]?.message ?? "request body did not match the schema",
    });
  }

  return parsed.data;
}

function errorResponse(c: { json: (body: unknown, status?: number) => Response }, error: Error) {
  const status = error instanceof ValidationError ? 400 : 500;
  return c.json({ error: error.message }, status);
}
