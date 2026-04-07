import * as errore from "errore";
import { Hono, type Context as HonoContext } from "hono";
import { z } from "zod";

import { buildStartupContext } from "./context.ts";
import type { TempleDatabase } from "./db.ts";
import { recordRetrievalFeedback, rememberEpisode, searchEpisodes } from "./episodic.ts";
import { ServerStartError, ValidationError } from "./errors.ts";
import { runConsolidationCycle } from "./consolidation.ts";
import { recordObservation } from "./behavioral.ts";
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
