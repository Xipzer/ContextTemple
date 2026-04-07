import { buildBehavioralContext } from "./behavioral.ts";
import type { TempleDatabase } from "./db.ts";
import { buildEpisodicContext } from "./episodic.ts";
import type { StartupContext } from "./types.ts";

export async function buildStartupContext({
  temple,
  project,
  query,
  maxRules = 8,
  maxMemories = 4,
}: {
  temple: TempleDatabase;
  project?: string | null;
  query?: string | null;
  maxRules?: number;
  maxMemories?: number;
}) {
  const behavioral = await buildBehavioralContext({ temple, project, maxRules });
  if (behavioral instanceof Error) return behavioral;

  const episodic = await buildEpisodicContext({ temple, project, query, limit: maxMemories });
  if (episodic instanceof Error) return episodic;

  const markdown = [
    "# ContextTemple Startup Context",
    "",
    "## Protocol",
    "- Default to the behavioral layer for how to operate.",
    "- Use episodic memory for factual recall and prior decisions.",
    "- If fresh user instructions conflict with stored context, prefer the fresh instruction and update ContextTemple later.",
    "",
    behavioral.markdown,
    "",
    episodic.markdown,
  ].join("\n");

  return {
    markdown,
    project: project?.trim() || null,
    query: query?.trim() || null,
    rules: behavioral.rules,
    memories: episodic.memories,
  } satisfies StartupContext;
}
