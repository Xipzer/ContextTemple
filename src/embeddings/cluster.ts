import { cosineSimilarity } from "../retrieval/semantic.ts";

export type EmbeddingClusterItem = {
  id: string;
  label: string;
  embedding: number[];
  semanticTerms: string[];
};

export type EmbeddingCluster = {
  id: string;
  label: string;
  itemIds: string[];
  similarity: number;
};

export function clusterEmbeddingItems({
  items,
  threshold = 0.84,
}: {
  items: EmbeddingClusterItem[];
  threshold?: number;
}) {
  const visited = new Set<string>();
  const clusters: EmbeddingCluster[] = [];

  for (const item of items) {
    if (visited.has(item.id)) continue;
    const memberIds = [item.id];
    visited.add(item.id);
    let similarityTotal = 1;
    let similarityCount = 1;

    for (const candidate of items) {
      if (visited.has(candidate.id)) continue;
      const similarity = cosineSimilarity(item.embedding, candidate.embedding);
      if (similarity < threshold) continue;

      memberIds.push(candidate.id);
      visited.add(candidate.id);
      similarityTotal += similarity;
      similarityCount += 1;
    }

    clusters.push({
      id: `cluster:${item.id}`,
      label: item.label,
      itemIds: memberIds,
      similarity: Number((similarityTotal / similarityCount).toFixed(4)),
    });
  }

  return clusters.sort((left, right) => right.itemIds.length - left.itemIds.length || right.similarity - left.similarity);
}
