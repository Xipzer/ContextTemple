import { randomUUID } from "node:crypto";

import { and, eq, or } from "drizzle-orm";

import type { TempleDatabase } from "../db.ts";
import { DatabaseQueryError } from "../errors.ts";
import { behavioralRules, episodicMemories, memoryConflicts, ruleConflicts } from "../schema.ts";
import { buildFingerprint, jaccardSimilarity, normalizeText, tokenize } from "../text.ts";
import { cosineSimilarity } from "../retrieval/semantic.ts";
import type { IndexedMemory } from "../retrieval/hybrid.ts";
import type { StoredMemory, StoredMemoryConflict, StoredRule, StoredRuleConflict } from "../types.ts";

export async function detectAndPersistRuleConflicts({
  temple,
  rules,
}: {
  temple: TempleDatabase;
  rules: StoredRule[];
}) {
  const activeRules = rules.filter((rule) => rule.status === "active");
  const conflictPairs = collectRuleConflictPairs(activeRules);
  const existingConflicts = await temple.db.select().from(ruleConflicts).catch(
    (cause) => new DatabaseQueryError({ operation: "fetch rule conflicts", cause }),
  );
  if (existingConflicts instanceof Error) return existingConflicts;

  const desiredKeys = new Set(conflictPairs.map((pair) => pair.key));
  let conflictedRules = 0;
  let resolvedRuleConflicts = 0;
  const conflictedRuleIds = new Set<string>();

  for (const pair of conflictPairs) {
    const existing = existingConflicts.find((candidate) => candidateKey(candidate.leftRuleId, candidate.rightRuleId) === pair.key);
    if (!existing) {
      const insertResult = await temple.db.insert(ruleConflicts).values({
        id: randomUUID(),
        leftRuleId: pair.left.id,
        rightRuleId: pair.right.id,
        project: pair.project,
        reason: pair.reason,
        status: "open",
        createdAt: new Date(),
        resolvedAt: null,
      }).catch((cause) => new DatabaseQueryError({ operation: "insert rule conflict", cause }));
      if (insertResult instanceof Error) return insertResult;
    } else if (existing.status === "resolved") {
      const reopenResult = await temple.db
        .update(ruleConflicts)
        .set({ status: "open", resolvedAt: null, reason: pair.reason })
        .where(eq(ruleConflicts.id, existing.id))
        .catch((cause) => new DatabaseQueryError({ operation: "reopen rule conflict", cause }));
      if (reopenResult instanceof Error) return reopenResult;
    }

    conflictedRuleIds.add(pair.left.id);
    conflictedRuleIds.add(pair.right.id);
  }

  for (const conflict of existingConflicts.filter((candidate) => candidate.status === "open" && !desiredKeys.has(candidateKey(candidate.leftRuleId, candidate.rightRuleId)))) {
    const resolveResult = await temple.db
      .update(ruleConflicts)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(ruleConflicts.id, conflict.id))
      .catch((cause) => new DatabaseQueryError({ operation: "resolve rule conflict", cause }));
    if (resolveResult instanceof Error) return resolveResult;
    resolvedRuleConflicts += 1;
  }

  for (const rule of rules) {
    const nextStatus = conflictedRuleIds.has(rule.id) ? "conflicted" : rule.status === "conflicted" ? "active" : rule.status;
    if (nextStatus === rule.status) continue;

    const updateResult = await temple.db
      .update(behavioralRules)
      .set({ status: nextStatus })
      .where(eq(behavioralRules.id, rule.id))
      .catch((cause) => new DatabaseQueryError({ operation: "update rule lifecycle status", cause }));
    if (updateResult instanceof Error) return updateResult;

    rule.status = nextStatus;
    if (nextStatus === "conflicted") conflictedRules += 1;
  }

  return {
    conflictedRules,
    resolvedRuleConflicts,
  };
}

export async function listRuleConflictRecords({ temple }: { temple: TempleDatabase }) {
  const rows = await temple.db.select().from(ruleConflicts).catch(
    (cause) => new DatabaseQueryError({ operation: "list rule conflicts", cause }),
  );
  if (rows instanceof Error) return rows;
  return rows.map(mapRuleConflict);
}

export async function applyMemoryLifecycle({
  temple,
  insertedMemory,
  candidateMemories,
}: {
  temple: TempleDatabase;
  insertedMemory: IndexedMemory;
  candidateMemories: IndexedMemory[];
}) {
  const existingConflicts = await temple.db.select().from(memoryConflicts).catch(
    (cause) => new DatabaseQueryError({ operation: "fetch memory conflicts", cause }),
  );
  if (existingConflicts instanceof Error) return existingConflicts;

  let conflictedMemories = 0;
  let supersededMemories = 0;

  for (const candidate of candidateMemories) {
    const similarity = cosineSimilarity(insertedMemory.embedding, candidate.embedding);
    const overlap = jaccardSimilarity(insertedMemory.semanticTerms, candidate.semanticTerms);
    if (Math.max(similarity, overlap) < 0.32) continue;

    if (shouldSupersede({ older: candidate, newer: insertedMemory })) {
      const supersedeResult = await temple.db
        .update(episodicMemories)
        .set({ status: "superseded", supersededByMemoryId: insertedMemory.id, updatedAt: new Date() })
        .where(eq(episodicMemories.id, candidate.id))
        .catch((cause) => new DatabaseQueryError({ operation: "supersede episodic memory", cause }));
      if (supersedeResult instanceof Error) return supersedeResult;
      supersededMemories += 1;
      continue;
    }

    const contradictionReason = detectMemoryContradiction({ left: candidate, right: insertedMemory });
    if (!contradictionReason) continue;

    const conflictKey = candidateKey(candidate.id, insertedMemory.id);
    const existing = existingConflicts.find((row) => candidateKey(row.leftMemoryId, row.rightMemoryId) === conflictKey);
    if (!existing) {
      const insertResult = await temple.db.insert(memoryConflicts).values({
        id: randomUUID(),
        leftMemoryId: candidate.id,
        rightMemoryId: insertedMemory.id,
        project: insertedMemory.project,
        reason: contradictionReason,
        status: "open",
        createdAt: new Date(),
        resolvedAt: null,
      }).catch((cause) => new DatabaseQueryError({ operation: "insert memory conflict", cause }));
      if (insertResult instanceof Error) return insertResult;
    }

    const markExistingResult = await temple.db
      .update(episodicMemories)
      .set({ status: "conflicted", updatedAt: new Date() })
      .where(eq(episodicMemories.id, candidate.id))
      .catch((cause) => new DatabaseQueryError({ operation: "mark existing memory conflicted", cause }));
    if (markExistingResult instanceof Error) return markExistingResult;

    const markInsertedResult = await temple.db
      .update(episodicMemories)
      .set({ status: "conflicted", updatedAt: new Date() })
      .where(eq(episodicMemories.id, insertedMemory.id))
      .catch((cause) => new DatabaseQueryError({ operation: "mark inserted memory conflicted", cause }));
    if (markInsertedResult instanceof Error) return markInsertedResult;

    conflictedMemories += 2;
  }

  return {
    conflictedMemories,
    supersededMemories,
  };
}

export async function listMemoryConflictRecords({ temple }: { temple: TempleDatabase }) {
  const rows = await temple.db.select().from(memoryConflicts).catch(
    (cause) => new DatabaseQueryError({ operation: "list memory conflicts", cause }),
  );
  if (rows instanceof Error) return rows;
  return rows.map(mapMemoryConflict);
}

function collectRuleConflictPairs(rules: StoredRule[]) {
  const pairs: Array<{ key: string; left: StoredRule; right: StoredRule; project: string | null; reason: string }> = [];

  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    const left = rules[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const right = rules[rightIndex]!;
      if (left.dimension !== right.dimension) continue;
      if (!sharesRuleScope(left, right)) continue;

      const reason = detectRuleContradiction({ left, right });
      if (!reason) continue;

      pairs.push({
        key: candidateKey(left.id, right.id),
        left,
        right,
        project: left.project ?? right.project,
        reason,
      });
    }
  }

  return pairs;
}

function detectRuleContradiction({ left, right }: { left: StoredRule; right: StoredRule }) {
  const leftNormalized = normalizeText(left.statement);
  const rightNormalized = normalizeText(right.statement);
  const lexicalSimilarity = jaccardSimilarity(tokenize(left.statement), tokenize(right.statement));

  if (lexicalSimilarity >= 0.25 && hasNegationMismatch(leftNormalized, rightNormalized)) {
    return "negation mismatch on overlapping rule statements";
  }

  if (left.dimension === "style" && expressesStyleOpposition(leftNormalized, rightNormalized)) {
    return "style rules point in opposite directions";
  }

  return null;
}

function detectMemoryContradiction({ left, right }: { left: IndexedMemory; right: IndexedMemory }) {
  const leftNormalized = normalizeText(left.content);
  const rightNormalized = normalizeText(right.content);
  const overlap = jaccardSimilarity(left.semanticTerms, right.semanticTerms);
  if (overlap < 0.22) return null;

  if (hasNegationMismatch(leftNormalized, rightNormalized)) {
    return "memory statements disagree on the same topic";
  }

  if (mentionsReplacement(leftNormalized) !== mentionsReplacement(rightNormalized) && overlap >= 0.3) {
    return "memory statements appear to describe incompatible current states";
  }

  return null;
}

function shouldSupersede({ older, newer }: { older: IndexedMemory; newer: IndexedMemory }) {
  if (!older.source || !newer.source) return false;
  if (older.source !== newer.source) return false;
  if (!mentionsReplacement(normalizeText(newer.content))) return false;

  const overlap = jaccardSimilarity(older.semanticTerms, newer.semanticTerms);
  return overlap >= 0.2;
}

function sharesRuleScope(left: StoredRule, right: StoredRule) {
  if (left.scope === "global" || right.scope === "global") {
    return left.project === right.project || left.project === null || right.project === null;
  }

  return left.project === right.project;
}

function hasNegationMismatch(left: string, right: string) {
  const leftNegated = /(never|don't|do not|must not|avoid|no longer)/.test(left);
  const rightNegated = /(never|don't|do not|must not|avoid|no longer)/.test(right);
  return leftNegated !== rightNegated;
}

function expressesStyleOpposition(left: string, right: string) {
  const concise = /(terse|brief|concise|direct|short|succinct)/;
  const verbose = /(verbose|detailed|thorough|explain|elaborate|long-form)/;

  return (concise.test(left) && verbose.test(right)) || (verbose.test(left) && concise.test(right));
}

function mentionsReplacement(value: string) {
  return /(instead|replaced|replace|moved to|switch to|now uses|no longer|deprecated)/.test(value);
}

function candidateKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join("::");
}

function mapRuleConflict(row: typeof ruleConflicts.$inferSelect): StoredRuleConflict {
  return {
    id: row.id,
    leftRuleId: row.leftRuleId,
    rightRuleId: row.rightRuleId,
    project: row.project,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

function mapMemoryConflict(row: typeof memoryConflicts.$inferSelect): StoredMemoryConflict {
  return {
    id: row.id,
    leftMemoryId: row.leftMemoryId,
    rightMemoryId: row.rightMemoryId,
    project: row.project,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}
