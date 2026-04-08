import * as errore from "errore";
import { Hono } from "hono";

import type { TempleDatabase } from "../db.ts";
import { ServerStartError, ValidationError } from "../errors.ts";
import { completeRuntimeTurn, prepareRuntimeTurn } from "../runtime/orchestrator.ts";
import type { RuntimeMessage } from "../runtime/types.ts";

type LlamaCppChatRequest = {
  model?: string;
  messages: Array<{ role: string; content: string; name?: string | null }>;
  stream?: boolean;
  [key: string]: unknown;
};

export function createLlamaCppBridgeApp({
  temple,
  llamaCppUrl,
  defaultProject,
}: {
  temple: TempleDatabase;
  llamaCppUrl: string;
  defaultProject?: string | null;
}) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, llamaCppUrl }));

  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json().catch(
      (cause: Error) => new ValidationError({ field: "body", reason: "must be valid JSON", cause }),
    );
    if (body instanceof Error) return bridgeError(c, body);

    const request = validateChatRequest(body);
    if (request instanceof Error) return bridgeError(c, request);

    const project = c.req.header("x-contexttemple-project") ?? defaultProject ?? null;
    const runtimeMessages = request.messages.map(toRuntimeMessage);
    const plan = await prepareRuntimeTurn({ temple, project, messages: runtimeMessages });
    if (plan instanceof Error) return bridgeError(c, plan);

    const bridgedMessages = [
      ...plan.systemMessages.map((content) => ({ role: "system", content })),
      ...request.messages,
    ];

    const response = await fetch(new URL("/v1/chat/completions", llamaCppUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        stream: request.stream ?? false,
        messages: bridgedMessages,
      }),
    }).catch((cause) => new ValidationError({ field: "llamaCppUrl", reason: "request failed", cause }));
    if (response instanceof Error) return bridgeError(c, response);

    if (request.stream) {
      return streamBridgeResponse({
        response,
        temple,
        project,
        sessionId: c.req.header("x-contexttemple-session") ?? null,
        runtimeMessages,
      });
    }

    const payload = await response.json().catch(
      (cause: Error) => new ValidationError({ field: "llamaCpp response", reason: "must be valid JSON", cause }),
    );
    if (payload instanceof Error) return bridgeError(c, payload, response.status);

    const assistantMessage = extractAssistantMessage(payload);
    if (assistantMessage) {
      const writeback = await completeRuntimeTurn({
        temple,
        project,
        sessionId: c.req.header("x-contexttemple-session") ?? null,
        messages: runtimeMessages,
        assistantMessage,
      });
      if (writeback instanceof Error) return bridgeError(c, writeback);
    }

    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      return new Response(
        JSON.stringify({
          ...payload,
          contextTemple: {
            project,
            retrievalQuery: plan.retrievalQuery,
            retrievedMemoryCount: plan.retrievedMemories.length,
            ruleCount: plan.rules.length,
          },
        }),
        {
          status: response.status,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }

    return new Response(JSON.stringify(payload), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  return app;
}

export function startLlamaCppBridgeServer({
  temple,
  llamaCppUrl,
  port,
  defaultProject,
}: {
  temple: TempleDatabase;
  llamaCppUrl: string;
  port: number;
  defaultProject?: string | null;
}) {
  const app = createLlamaCppBridgeApp({ temple, llamaCppUrl, defaultProject });
  const server = errore.try({
    try: () => Bun.serve({ port, fetch: app.fetch }),
    catch: (cause) => new ServerStartError({ port: String(port), cause }),
  });
  if (server instanceof Error) return server;

  return { app, server };
}

function validateChatRequest(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new ValidationError({ field: "body", reason: "must be an object" });
  }

  const body = value as Partial<LlamaCppChatRequest>;
  if (!Array.isArray(body.messages)) {
    return new ValidationError({ field: "messages", reason: "must be an array" });
  }

  const validMessages = body.messages.every(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      typeof (message as { role?: unknown }).role === "string" &&
      typeof (message as { content?: unknown }).content === "string",
  );
  if (!validMessages) {
    return new ValidationError({ field: "messages", reason: "must contain role/content message objects" });
  }

  return body as LlamaCppChatRequest;
}

function toRuntimeMessage(message: { role: string; content: string; name?: string | null }): RuntimeMessage {
  return {
    role: normalizeRole(message.role),
    content: message.content,
    name: message.name ?? null,
  };
}

function normalizeRole(role: string): RuntimeMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
  return "user";
}

function extractAssistantMessage(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const choices = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices;
  return choices?.[0]?.message?.content ?? null;
}

function streamBridgeResponse({
  response,
  temple,
  project,
  sessionId,
  runtimeMessages,
}: {
  response: Response;
  temple: TempleDatabase;
  project: string | null;
  sessionId: string | null;
  runtimeMessages: RuntimeMessage[];
}) {
  if (!response.body) {
    return bridgeError(
      { json: (body: unknown, status?: number) => Response.json(body, { status }) },
      new ValidationError({ field: "llamaCpp stream", reason: "response had no body" }),
      response.status,
    );
  }

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let buffer = "";
  let assistantMessage = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        await maybeWriteback({ temple, project, sessionId, runtimeMessages, assistantMessage });
        controller.close();
        return;
      }

      if (value) {
        controller.enqueue(value);
        buffer += textDecoder.decode(value, { stream: true });
        assistantMessage += extractAssistantDelta(buffer);
        buffer = trimProcessedBuffer(buffer);
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "text/event-stream",
      "cache-control": response.headers.get("cache-control") ?? "no-cache",
      connection: response.headers.get("connection") ?? "keep-alive",
      "transfer-encoding": response.headers.get("transfer-encoding") ?? "chunked",
    },
  });
}

async function maybeWriteback({
  temple,
  project,
  sessionId,
  runtimeMessages,
  assistantMessage,
}: {
  temple: TempleDatabase;
  project: string | null;
  sessionId: string | null;
  runtimeMessages: RuntimeMessage[];
  assistantMessage: string;
}) {
  if (!assistantMessage.trim()) return;
  const writeback = await completeRuntimeTurn({
    temple,
    project,
    sessionId,
    messages: runtimeMessages,
    assistantMessage,
  });
  if (writeback instanceof Error) {
    console.warn(`ContextTemple streaming writeback failed: ${writeback.message}`);
  }
}

function extractAssistantDelta(buffer: string) {
  const events = buffer.split("\n\n");
  if (events.length <= 1) return "";

  const completeEvents = events.slice(0, -1);
  let delta = "";
  for (const event of completeEvents) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
        delta += parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      } catch {
        continue;
      }
    }
  }

  return delta;
}

function trimProcessedBuffer(buffer: string) {
  const boundary = buffer.lastIndexOf("\n\n");
  return boundary === -1 ? buffer : buffer.slice(boundary + 2);
}

function bridgeError(
  c: { json: (body: unknown, status?: number) => Response },
  error: Error,
  status = error instanceof ValidationError ? 400 : 500,
) {
  return c.json({ error: error.message }, status);
}
