import type { TempleDatabase } from "../db.ts";
import { buildStartupContext } from "../context.ts";

export type AgentInstructionsFormat = "claude-md" | "agents-md" | "raw-markdown";

export async function generateAgentInstructions({
  temple,
  project,
  format = "claude-md",
  query,
  maxRules = 12,
  maxMemories = 6,
}: {
  temple: TempleDatabase;
  project?: string | null;
  format?: AgentInstructionsFormat;
  query?: string | null;
  maxRules?: number;
  maxMemories?: number;
}) {
  const context = await buildStartupContext({ temple, project, query, maxRules, maxMemories });
  if (context instanceof Error) return context;

  const toolPolicy = buildToolCallingPolicy();
  const sections: string[] = [];

  if (format === "claude-md") {
    sections.push("# ContextTemple Memory Layer");
    sections.push("");
    sections.push("This project uses ContextTemple for persistent memory across sessions.");
    sections.push("The following rules and memories were synthesized from prior interactions.");
    sections.push("Follow the behavioral rules unless the user explicitly overrides them.");
    sections.push("");
  } else if (format === "agents-md") {
    sections.push("# Agent Memory Instructions");
    sections.push("");
    sections.push("This agent has access to ContextTemple memory tools.");
    sections.push("Use them according to the tool-calling policy below.");
    sections.push("");
  }

  sections.push(context.markdown);
  sections.push("");
  sections.push(toolPolicy);

  const markdown = sections.join("\n");

  return {
    markdown,
    format,
    project: context.project,
    ruleCount: context.rules.length,
    memoryCount: context.memories.length,
  };
}

function buildToolCallingPolicy() {
  return [
    "## ContextTemple Tool-Calling Policy",
    "",
    "When ContextTemple MCP tools are available, follow these rules:",
    "",
    "### Session Start",
    "- Call `contexttemple_startup_context` at the beginning of each session to load behavioral rules and relevant episodic memory.",
    "- Include the user's first message as the `query` parameter so retrieval is scoped to the topic.",
    "",
    "### During the Session",
    "- Call `contexttemple_search_memory` when the user asks about prior decisions, project history, preferences, or anything that happened in a previous session.",
    "- Call `contexttemple_record_observation` when the user corrects your behavior, workflow, tone, or style. Use the appropriate dimension: guard, workflow, style, preference, or failure.",
    "- Call `contexttemple_remember_episode` when a durable decision, fact, or outcome is established during the session.",
    "",
    "### Session End",
    "- Call `contexttemple_runtime_complete` with the final user message and your last response so ContextTemple can automatically extract observations and outcomes.",
    "",
    "### Conflict Resolution",
    "- If `contexttemple_list_rule_conflicts` or `contexttemple_list_memory_conflicts` returns open conflicts, inform the user and offer to resolve them using `contexttemple_resolve_rule_conflict` or `contexttemple_resolve_memory_conflict`.",
    "",
    "### General",
    "- If fresh user instructions conflict with stored behavioral rules, follow the fresh instruction and record a new observation to update the stored rule.",
    "- Do not call memory tools speculatively. Only search when there is a genuine factual question or when the user references prior context.",
    "- Do not store transient implementation details as episodic memory. Only store decisions, outcomes, and durable facts.",
  ].join("\n");
}
