import { recordObservation } from "../behavioral.ts";
import type { TempleDatabase } from "../db.ts";
import { rememberEpisode } from "../episodic.ts";
import type { RuntimeWritebackResult } from "./types.ts";

export async function writebackRuntimeTurn({
  temple,
  project,
  sessionId,
  userMessage,
  assistantMessage,
}: {
  temple: TempleDatabase;
  project?: string | null;
  sessionId?: string | null;
  userMessage?: string | null;
  assistantMessage?: string | null;
}) {
  const observationsAdded: string[] = [];
  const memoriesAdded: string[] = [];

  if (userMessage?.trim()) {
    const observation = deriveObservation(userMessage);
    if (observation) {
      const result = await recordObservation({
        temple,
        input: {
          project,
          dimension: observation.dimension,
          statement: userMessage,
          evidence: `runtime writeback from session ${sessionId ?? "unknown"}`,
          confidence: observation.confidence,
        },
      });
      if (!(result instanceof Error)) observationsAdded.push(result.id);
    }

    if (looksLikeDurableUserFact(userMessage)) {
      const result = await rememberEpisode({
        temple,
        input: {
          project,
          source: buildRuntimeSource({ sessionId, role: "user" }),
          content: userMessage,
          tags: ["runtime", "user"],
          salience: 7,
        },
      });
      if (!(result instanceof Error)) memoriesAdded.push(result.id);
    }
  }

  if (assistantMessage?.trim() && looksLikeAssistantOutcome(assistantMessage)) {
    const result = await rememberEpisode({
      temple,
      input: {
        project,
        source: buildRuntimeSource({ sessionId, role: "assistant" }),
        content: assistantMessage,
        tags: ["runtime", "assistant", "outcome"],
        salience: 6,
      },
    });
    if (!(result instanceof Error)) memoriesAdded.push(result.id);
  }

  return {
    observationsAdded,
    memoriesAdded,
  } satisfies RuntimeWritebackResult;
}

function deriveObservation(value: string) {
  const normalized = value.toLowerCase();
  if (/(always|never|do not|don't|must|must not)/.test(normalized)) return { dimension: "guard" as const, confidence: 0.84 };
  if (/(terse|brief|concise|direct|verbose|detailed|execution-focused)/.test(normalized)) {
    return { dimension: "style" as const, confidence: 0.8 };
  }
  if (/(before editing|before claiming|run .*check|read the file|inspect)/.test(normalized)) {
    return { dimension: "workflow" as const, confidence: 0.82 };
  }
  if (/(prefer|please use|use chakra|keep responses)/.test(normalized)) return { dimension: "preference" as const, confidence: 0.76 };
  if (/(you kept|you failed|stop doing|mistake|annoying)/.test(normalized)) return { dimension: "failure" as const, confidence: 0.74 };
  return null;
}

function looksLikeDurableUserFact(value: string) {
  return /(we decided|decided to|depends on|requires|we are using|we're using|we will use|we'll use)/i.test(value);
}

function looksLikeAssistantOutcome(value: string) {
  return /(implemented|fixed|completed|finished|tests passed|shipped|done)/i.test(value);
}

function buildRuntimeSource({
  sessionId,
  role,
}: {
  sessionId?: string | null;
  role: "user" | "assistant";
}) {
  return `runtime:${sessionId ?? "session"}:${role}`;
}
