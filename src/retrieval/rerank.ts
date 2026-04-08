import { normalizeText, overlapRatio, tokenize } from "../text.ts";
import { buildQuerySemanticIndex } from "./semantic.ts";
import type { RankedMemory } from "./hybrid.ts";

export function rerankHybridMemories({
  ranked,
  query,
  topK = 12,
}: {
  ranked: RankedMemory[];
  query: string;
  topK?: number;
}) {
  const trimmedQuery = query.trim();
  const queryTokens = tokenize(trimmedQuery);
  const normalizedQuery = normalizeText(trimmedQuery);
  const semanticQuery = buildQuerySemanticIndex(trimmedQuery);

  return ranked
    .sort((left, right) => right.scoreBreakdown.total - left.scoreBreakdown.total)
    .slice(0, topK)
    .map((result) => {
      const summaryTokens = tokenize(result.memory.summary);
      const semanticCoverage = overlapRatio(semanticQuery.semanticTerms, result.memory.semanticTerms) * 0.12;
      const summaryCoverage = overlapRatio(queryTokens, summaryTokens) * 0.04;
      const openingBonus = normalizeText(result.memory.summary).startsWith(normalizedQuery) ? 0.03 : 0;
      const sourceBonus = result.memory.source?.startsWith("extracted-candidate:") ? 0.015 : 0;
      const rerank = semanticCoverage + summaryCoverage + openingBonus + sourceBonus;

      return {
        ...result,
        scoreBreakdown: {
          ...result.scoreBreakdown,
          rerank,
          total: result.scoreBreakdown.total + rerank,
        },
      };
    })
    .sort((left, right) => right.scoreBreakdown.total - left.scoreBreakdown.total);
}
