import type { TempleDatabase } from "./db.ts";
import { consolidateBehavioralMemory } from "./behavioral.ts";

export async function runConsolidationCycle({
  temple,
  project,
}: {
  temple: TempleDatabase;
  project?: string | null;
}) {
  return consolidateBehavioralMemory({ temple, project });
}
