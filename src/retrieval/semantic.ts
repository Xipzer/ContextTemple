import { extractKeywords, normalizeText, tokenize, uniqueStrings } from "../text.ts";

const embeddingDimensions = 192;

const semanticExpansionMap: Record<string, string[]> = {
  auth: ["authentication", "login", "signin", "oauth", "identity", "credential"],
  authentication: ["auth", "login", "signin", "oauth", "identity", "credential"],
  login: ["auth", "authentication", "signin", "oauth", "identity"],
  oauth: ["auth", "authentication", "token", "device", "approval", "identity"],
  device: ["device-code", "approval", "code", "polling"],
  "device-code": ["device", "approval", "polling", "code", "oauth"],
  code: ["device-code", "authorization-code", "approval"],
  polling: ["poll", "approval", "device", "oauth"],
  migrate: ["migration", "switch", "move", "upgrade", "transition"],
  migration: ["migrate", "switch", "move", "upgrade", "transition"],
  terse: ["brief", "concise", "direct", "short"],
  concise: ["terse", "brief", "direct", "short"],
  succinct: ["terse", "concise", "brief", "short"],
  direct: ["terse", "brief", "concise"],
  answer: ["response", "reply", "replies"],
  mode: ["style", "behavior", "tone"],
  file: ["source", "module", "document"],
  files: ["file", "source", "module", "document"],
  editing: ["edit", "modify", "change"],
  edit: ["editing", "modify", "change"],
  tests: ["checks", "verification", "validated"],
  test: ["checks", "verification", "validated"],
  flow: ["workflow", "process", "protocol"],
  protocol: ["flow", "workflow", "process"],
  complete: ["finished", "done", "verified"],
  finished: ["complete", "done", "verified"],
  verify: ["check", "checks", "validated", "test", "tests"],
  checks: ["verify", "validated", "tests"],
  response: ["reply", "replies", "answer"],
  responses: ["reply", "replies", "answer"],
  reply: ["response", "responses", "answer"],
  replies: ["response", "responses", "answer"],
  dashboard: ["monitoring", "page", "panel", "console"],
  monitoring: ["dashboard", "page", "panel", "console"],
  page: ["dashboard", "screen", "panel"],
  meeting: ["review", "session", "calendar"],
  review: ["meeting", "session", "calendar"],
  planning: ["review", "meeting", "schedule"],
  backend: ["server", "server-side", "api"],
  server: ["backend", "server-side", "api"],
  token: ["credential", "refresh", "session"],
  tokens: ["token", "credential", "refresh", "session"],
};

type WeightedTerm = {
  term: string;
  weight: number;
};

export function buildSemanticIndex({
  content,
  summary,
  tags,
}: {
  content: string;
  summary: string;
  tags: string[];
}) {
  const weightedTerms = collectWeightedTerms({ content, summary, tags });
  const semanticTerms = uniqueStrings(weightedTerms.map((item) => item.term));
  const embedding = createEmbedding(weightedTerms);

  return {
    semanticTerms,
    embedding,
  };
}

export function buildQuerySemanticIndex(query: string) {
  return buildSemanticIndex({
    content: query,
    summary: query,
    tags: [],
  });
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || right.length === 0) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const size = Math.min(left.length, right.length);

  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function collectWeightedTerms({
  content,
  summary,
  tags,
}: {
  content: string;
  summary: string;
  tags: string[];
}) {
  const weightedTerms: WeightedTerm[] = [];

  for (const term of tokenize(content)) {
    weightedTerms.push({ term, weight: 1 });
    for (const expansion of semanticExpansionMap[term] ?? []) {
      weightedTerms.push({ term: expansion, weight: 0.55 });
    }
    for (const ngram of toCharacterNgrams(term)) {
      weightedTerms.push({ term: ngram, weight: 0.18 });
    }
  }

  for (const term of tokenize(summary)) {
    weightedTerms.push({ term, weight: 0.8 });
  }

  for (const term of tags.flatMap((tag) => tokenize(tag))) {
    weightedTerms.push({ term, weight: 1.1 });
    for (const expansion of semanticExpansionMap[term] ?? []) {
      weightedTerms.push({ term: expansion, weight: 0.45 });
    }
  }

  for (const term of extractKeywords({ content: normalizeText(content), tags })) {
    weightedTerms.push({ term, weight: 0.4 });
  }

  return weightedTerms;
}

function createEmbedding(weightedTerms: WeightedTerm[]) {
  const vector = Array.from({ length: embeddingDimensions }, () => 0);

  for (const { term, weight } of weightedTerms) {
    const index = stableHash(term) % embeddingDimensions;
    vector[index] = (vector[index] ?? 0) + weight;
  }

  return normalizeVector(vector);
}

function normalizeVector(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function toCharacterNgrams(term: string) {
  if (term.length < 5) return [];
  const ngrams: string[] = [];

  for (let index = 0; index <= term.length - 3; index += 1) {
    ngrams.push(`ng:${term.slice(index, index + 3)}`);
  }

  return ngrams;
}
