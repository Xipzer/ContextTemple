import * as errore from "errore";

import { ValidationError } from "../errors.ts";
import { buildSemanticIndex } from "../retrieval/semantic.ts";
import type { EmbeddingProviderName } from "../types.ts";

export type EmbeddingProviderConfig = {
  provider: EmbeddingProviderName;
  model: string | null;
  url: string | null;
  apiKey: string | null;
};

export type EmbeddedText = {
  embedding: number[];
  semanticTerms: string[];
  provider: EmbeddingProviderName;
  model: string | null;
};

export function resolveEmbeddingProviderConfig({
  provider,
  model,
  url,
  apiKey,
}: Partial<EmbeddingProviderConfig> = {}) {
  return {
    provider: provider ?? (process.env.CONTEXTTEMPLE_EMBEDDING_PROVIDER as EmbeddingProviderName | undefined) ?? "hashed",
    model: model ?? process.env.CONTEXTTEMPLE_EMBEDDING_MODEL ?? null,
    url: url ?? process.env.CONTEXTTEMPLE_EMBEDDING_URL ?? null,
    apiKey: apiKey ?? process.env.CONTEXTTEMPLE_EMBEDDING_API_KEY ?? null,
  } satisfies EmbeddingProviderConfig;
}

export async function embedText({
  text,
  tags = [],
  config,
}: {
  text: string;
  tags?: string[];
  config?: Partial<EmbeddingProviderConfig>;
}) {
  const resolvedConfig = resolveEmbeddingProviderConfig(config);
  const semanticIndex = buildSemanticIndex({ content: text, summary: text, tags });

  if (resolvedConfig.provider === "hashed") {
    return {
      embedding: semanticIndex.embedding,
      semanticTerms: semanticIndex.semanticTerms,
      provider: "hashed",
      model: null,
    } satisfies EmbeddedText;
  }

  if (!resolvedConfig.url) {
    return new ValidationError({ field: "embedding provider", reason: "requires CONTEXTTEMPLE_EMBEDDING_URL or an explicit url" });
  }

  const response = await fetch(resolveEmbeddingEndpoint(resolvedConfig), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(resolvedConfig.apiKey ? { authorization: `Bearer ${resolvedConfig.apiKey}` } : {}),
    },
    body: JSON.stringify({
      input: text,
      model: resolvedConfig.model ?? undefined,
    }),
  }).catch((cause) => new ValidationError({ field: "embedding provider", reason: "request failed", cause }));
  if (response instanceof Error) return response;

  if (!response.ok) {
    return new ValidationError({ field: "embedding provider", reason: `returned HTTP ${response.status}` });
  }

  const payload = await response.json().catch(
    (cause: Error) => new ValidationError({ field: "embedding provider", reason: "returned invalid JSON", cause }),
  );
  if (payload instanceof Error) return payload;

  const embedding = extractEmbedding(payload);
  if (embedding instanceof Error) return embedding;

  return {
    embedding,
    semanticTerms: semanticIndex.semanticTerms,
    provider: resolvedConfig.provider,
    model: resolvedConfig.model,
  } satisfies EmbeddedText;
}

export async function embedTexts({
  texts,
  config,
}: {
  texts: string[];
  config?: Partial<EmbeddingProviderConfig>;
}) {
  const results: EmbeddedText[] = [];
  for (const text of texts) {
    const embedded = await embedText({ text, config });
    if (embedded instanceof Error) return embedded;
    results.push(embedded);
  }
  return results;
}

function resolveEmbeddingEndpoint(config: EmbeddingProviderConfig) {
  const base = new URL(config.url!);
  if (config.provider === "llamacpp") {
    return new URL(base.pathname.endsWith("/embeddings") ? base : new URL("/v1/embeddings", base));
  }
  return new URL(base.pathname.endsWith("/embeddings") ? base : new URL("/v1/embeddings", base));
}

function extractEmbedding(payload: unknown) {
  const data =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as { data?: Array<{ embedding?: unknown }>; embedding?: unknown })
      : null;

  const rawEmbedding = data?.data?.[0]?.embedding ?? data?.embedding;
  if (!Array.isArray(rawEmbedding)) {
    return new ValidationError({ field: "embedding provider", reason: "response did not include an embedding array" });
  }

  const embedding = rawEmbedding.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (embedding.length === 0) {
    return new ValidationError({ field: "embedding provider", reason: "embedding array was empty or invalid" });
  }

  return normalizeEmbedding(embedding);
}

function normalizeEmbedding(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}
