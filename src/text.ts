const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
]);

export function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function tokenize(value: string) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export function buildFingerprint(value: string) {
  return uniqueStrings(tokenize(value)).sort().join("|");
}

export function jaccardSimilarity(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) return 0;
  return intersection / union;
}

export function extractKeywords({
  content,
  tags,
}: {
  content: string;
  tags: string[];
}) {
  return uniqueStrings([...tokenize(content), ...tags.flatMap((tag) => tokenize(tag))]).slice(0, 32);
}

export function summarizeContent(value: string, maxLength = 220) {
  const squashed = value.replace(/\s+/g, " ").trim();
  if (squashed.length <= maxLength) return squashed;
  return `${squashed.slice(0, maxLength - 1).trim()}…`;
}

export function overlapRatio(queryTokens: string[], candidateTokens: string[]) {
  if (queryTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  const overlap = queryTokens.filter((token) => candidateSet.has(token)).length;
  return overlap / queryTokens.length;
}
