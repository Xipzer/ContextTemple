import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gte, isNull, or } from "drizzle-orm";

import { behavioralRules, observations } from "./schema.ts";
import { buildFingerprint, jaccardSimilarity, tokenize } from "./text.ts";
import { clamp, parseJsonStringArray, stringifyJson } from "./utils.ts";
import { DatabaseQueryError, ValidationError } from "./errors.ts";
import type {
  BehavioralContextSnapshot,
  ConsolidationReport,
  ObservationInput,
  StoredObservation,
  StoredRule,
} from "./types.ts";
import type { TempleDatabase } from "./db.ts";

function mapObservation(row: typeof observations.$inferSelect): StoredObservation {
  return {
    id: row.id,
    project: row.project,
    dimension: row.dimension,
    statement: row.statement,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    confidence: row.confidence,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}

function mapRule(row: typeof behavioralRules.$inferSelect): StoredRule {
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    project: row.project,
    dimension: row.dimension,
    statement: row.statement,
    fingerprint: row.fingerprint,
    rationale: row.rationale,
    weight: row.weight,
    evidenceCount: row.evidenceCount,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    sourceObservationIds: parseJsonStringArray({
      value: row.sourceObservationIdsJson,
      context: `behavioral_rule:${row.id}`,
    }),
  };
}

export async function recordObservation({
  temple,
  input,
}: {
  temple: TempleDatabase;
  input: ObservationInput;
}) {
  const statement = input.statement.trim();
  if (!statement) {
    return new ValidationError({ field: "statement", reason: "must not be empty" });
  }

  const confidence = clamp(input.confidence ?? 0.7, 0.1, 1);
  const project = input.project?.trim() || null;
  const observation = {
    id: randomUUID(),
    project,
    dimension: input.dimension,
    statement,
    fingerprint: buildFingerprint(statement),
    evidence: input.evidence?.trim() || null,
    confidence,
    createdAt: new Date(),
    processedAt: null,
  } satisfies typeof observations.$inferInsert;

  const insertResult = await temple.db.insert(observations).values(observation).catch(
    (cause) => new DatabaseQueryError({ operation: "record observation", cause }),
  );
  if (insertResult instanceof Error) return insertResult;

  return mapObservation(observation);
}

export async function listActiveRules({
  temple,
  project,
  minWeight = 0.3,
}: {
  temple: TempleDatabase;
  project?: string | null;
  minWeight?: number;
}) {
  const trimmedProject = project?.trim() || null;
  const rows = await (
    trimmedProject
      ? temple.db
          .select()
          .from(behavioralRules)
          .where(
            and(
              eq(behavioralRules.status, "active"),
              gte(behavioralRules.weight, minWeight),
              or(
                eq(behavioralRules.scope, "global"),
                and(eq(behavioralRules.scope, "project"), eq(behavioralRules.project, trimmedProject)),
              ),
            ),
          )
          .orderBy(desc(behavioralRules.weight), desc(behavioralRules.lastSeen))
      : temple.db
          .select()
          .from(behavioralRules)
          .where(and(eq(behavioralRules.status, "active"), gte(behavioralRules.weight, minWeight)))
          .orderBy(desc(behavioralRules.weight), desc(behavioralRules.lastSeen))
  ).catch((cause) => new DatabaseQueryError({ operation: "list active rules", cause }));
  if (rows instanceof Error) return rows;

  return rows.map(mapRule);
}

export async function consolidateBehavioralMemory({
  temple,
  project,
}: {
  temple: TempleDatabase;
  project?: string | null;
}) {
  const trimmedProject = project?.trim() || null;
  const report: ConsolidationReport = {
    processedObservations: 0,
    insertedRules: 0,
    updatedRules: 0,
    promotedRules: 0,
    retiredRules: 0,
  };

  const pendingRows = await (
    trimmedProject
      ? temple.db
          .select()
          .from(observations)
          .where(and(isNull(observations.processedAt), eq(observations.project, trimmedProject)))
          .orderBy(asc(observations.createdAt))
      : temple.db.select().from(observations).where(isNull(observations.processedAt)).orderBy(asc(observations.createdAt))
  ).catch((cause) => new DatabaseQueryError({ operation: "fetch pending observations", cause }));
  if (pendingRows instanceof Error) return pendingRows;

  if (pendingRows.length === 0) return report;

  const activeRows = await temple.db
    .select()
    .from(behavioralRules)
    .where(eq(behavioralRules.status, "active"))
    .catch((cause) => new DatabaseQueryError({ operation: "fetch active behavioral rules", cause }));
  if (activeRows instanceof Error) return activeRows;

  const workingRules = activeRows.map((row) => ({ ...mapRule(row), weight: clamp(row.weight * 0.98, 0.05, 1) }));

  for (const rule of workingRules) {
    const decayResult = await temple.db
      .update(behavioralRules)
      .set({ weight: rule.weight })
      .where(eq(behavioralRules.id, rule.id))
      .catch((cause) => new DatabaseQueryError({ operation: "decay behavioral rule", cause }));
    if (decayResult instanceof Error) return decayResult;
  }

  for (const row of pendingRows) {
    const observation = mapObservation(row);
    const scope = observation.project ? "project" : "global";
    const match = findBestRuleMatch({ observation, scope, rules: workingRules });

    if (match) {
      const nextWeight = clamp(match.weight * 0.7 + observation.confidence * 0.3 + 0.08, 0.1, 1);
      const nextSources = [...new Set([...match.sourceObservationIds, observation.id])];
      const encodedSources = stringifyJson({
        value: nextSources,
        context: `behavioral_rule:${match.id}:sources`,
      });
      if (encodedSources instanceof Error) return encodedSources;

      const updateResult = await temple.db
        .update(behavioralRules)
        .set({
          weight: nextWeight,
          evidenceCount: match.evidenceCount + 1,
          lastSeen: observation.createdAt,
          rationale: match.rationale ?? observation.evidence,
          sourceObservationIdsJson: encodedSources,
        })
        .where(eq(behavioralRules.id, match.id))
        .catch((cause) => new DatabaseQueryError({ operation: "update behavioral rule", cause }));
      if (updateResult instanceof Error) return updateResult;

      match.weight = nextWeight;
      match.evidenceCount += 1;
      match.lastSeen = observation.createdAt;
      match.rationale ??= observation.evidence;
      match.sourceObservationIds = nextSources;
      report.updatedRules += 1;
    } else {
      const sourceObservationIdsJson = stringifyJson({
        value: [observation.id],
        context: `observation:${observation.id}:sources`,
      });
      if (sourceObservationIdsJson instanceof Error) return sourceObservationIdsJson;

      const newRule = {
        id: randomUUID(),
        scope,
        status: "active" as const,
        project: observation.project,
        dimension: observation.dimension,
        statement: observation.statement,
        fingerprint: observation.fingerprint,
        rationale: observation.evidence,
        weight: Math.max(0.4, observation.confidence),
        evidenceCount: 1,
        firstSeen: observation.createdAt,
        lastSeen: observation.createdAt,
        sourceObservationIds: [observation.id],
      } satisfies StoredRule;

      const insertResult = await temple.db
        .insert(behavioralRules)
        .values({
          id: newRule.id,
          scope: newRule.scope,
          status: newRule.status,
          project: newRule.project,
          dimension: newRule.dimension,
          statement: newRule.statement,
          fingerprint: newRule.fingerprint,
          rationale: newRule.rationale,
          weight: newRule.weight,
          evidenceCount: newRule.evidenceCount,
          firstSeen: newRule.firstSeen,
          lastSeen: newRule.lastSeen,
          sourceObservationIdsJson,
        })
        .catch((cause) => new DatabaseQueryError({ operation: "insert behavioral rule", cause }));
      if (insertResult instanceof Error) return insertResult;

      workingRules.push(newRule);
      report.insertedRules += 1;
    }

    const processedResult = await temple.db
      .update(observations)
      .set({ processedAt: new Date() })
      .where(eq(observations.id, observation.id))
      .catch((cause) => new DatabaseQueryError({ operation: "mark observation processed", cause }));
    if (processedResult instanceof Error) return processedResult;

    report.processedObservations += 1;
  }

  const promotedRules = await promoteCrossProjectRules({ temple, rules: workingRules });
  if (promotedRules instanceof Error) return promotedRules;
  report.promotedRules = promotedRules;

  for (const rule of workingRules.filter((candidate) => candidate.status === "active" && candidate.weight < 0.18)) {
    const retireResult = await temple.db
      .update(behavioralRules)
      .set({ status: "retired" })
      .where(eq(behavioralRules.id, rule.id))
      .catch((cause) => new DatabaseQueryError({ operation: "retire behavioral rule", cause }));
    if (retireResult instanceof Error) return retireResult;

    rule.status = "retired";
    report.retiredRules += 1;
  }

  return report;
}

export async function buildBehavioralContext({
  temple,
  project,
  maxRules = 8,
}: {
  temple: TempleDatabase;
  project?: string | null;
  maxRules?: number;
}) {
  const rules = await listActiveRules({ temple, project, minWeight: 0.3 });
  if (rules instanceof Error) return rules;

  const selected = rules.slice(0, maxRules);
  const globalRules = selected.filter((rule) => rule.scope === "global");
  const projectRules = selected.filter((rule) => rule.scope === "project");
  const lines = [
    "## Behavioral Memory",
    "- Treat these as durable operating constraints for the current user.",
    "- If fresh user instructions conflict with stored rules, prefer the fresh instruction and update memory later.",
  ];

  if (globalRules.length > 0) {
    lines.push("", "### Global Rules");
    for (const rule of globalRules) {
      lines.push(`- ${rule.statement}`);
    }
  }

  if (projectRules.length > 0) {
    lines.push("", "### Project Rules");
    for (const rule of projectRules) {
      lines.push(`- ${rule.statement}`);
    }
  }

  if (selected.length === 0) {
    lines.push("", "- No durable behavioral rules stored yet.");
  }

  return {
    markdown: lines.join("\n"),
    rules: selected,
  } satisfies BehavioralContextSnapshot;
}

function findBestRuleMatch({
  observation,
  scope,
  rules,
}: {
  observation: StoredObservation;
  scope: StoredRule["scope"];
  rules: StoredRule[];
}) {
  const candidates = rules.filter(
    (rule) =>
      rule.status === "active" &&
      rule.scope === scope &&
      rule.dimension === observation.dimension &&
      rule.project === (observation.project ?? null),
  );

  let best: StoredRule | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score =
      candidate.fingerprint === observation.fingerprint
        ? 1
        : jaccardSimilarity(tokenize(candidate.statement), tokenize(observation.statement));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore >= 0.72 ? best : null;
}

async function promoteCrossProjectRules({
  temple,
  rules,
}: {
  temple: TempleDatabase;
  rules: StoredRule[];
}) {
  const groups = new Map<string, StoredRule[]>();

  for (const rule of rules) {
    if (rule.status !== "active" || rule.scope !== "project" || !rule.project) continue;
    const key = `${rule.dimension}:${rule.fingerprint}`;
    const current = groups.get(key) ?? [];
    current.push(rule);
    groups.set(key, current);
  }

  let promotedCount = 0;

  for (const group of groups.values()) {
    const projects = [...new Set(group.map((rule) => rule.project).filter((project): project is string => Boolean(project)))];
    if (projects.length < 2) continue;

    const champion = [...group].sort((left, right) => right.weight - left.weight)[0];
    if (!champion) continue;
    const averageWeight = group.reduce((total, rule) => total + rule.weight, 0) / group.length;
    const sourceObservationIds = [...new Set(group.flatMap((rule) => rule.sourceObservationIds))];
    const encodedSources = stringifyJson({
      value: sourceObservationIds,
      context: `promoted_rule:${champion.id}:sources`,
    });
    if (encodedSources instanceof Error) return encodedSources;

    const existingGlobal = rules.find(
      (rule) =>
        rule.scope === "global" &&
        rule.status === "active" &&
        rule.dimension === champion.dimension &&
        rule.fingerprint === champion.fingerprint,
    );

    if (existingGlobal) {
      const nextWeight = clamp(Math.max(existingGlobal.weight, averageWeight + 0.1), 0.1, 1);
      const updateResult = await temple.db
        .update(behavioralRules)
        .set({
          weight: nextWeight,
          evidenceCount: Math.max(existingGlobal.evidenceCount, group.length),
          lastSeen: champion.lastSeen,
          rationale: existingGlobal.rationale ?? champion.rationale,
          sourceObservationIdsJson: encodedSources,
        })
        .where(eq(behavioralRules.id, existingGlobal.id))
        .catch((cause) => new DatabaseQueryError({ operation: "promote global behavioral rule", cause }));
      if (updateResult instanceof Error) return updateResult;

      existingGlobal.weight = nextWeight;
      existingGlobal.evidenceCount = Math.max(existingGlobal.evidenceCount, group.length);
      existingGlobal.lastSeen = champion.lastSeen;
      existingGlobal.rationale ??= champion.rationale;
      existingGlobal.sourceObservationIds = sourceObservationIds;
    } else {
      const newRule = {
        id: randomUUID(),
        scope: "global",
        status: "active",
        project: null,
        dimension: champion.dimension,
        statement: champion.statement,
        fingerprint: champion.fingerprint,
        rationale: champion.rationale,
        weight: clamp(averageWeight + 0.1, 0.1, 1),
        evidenceCount: group.length,
        firstSeen: champion.firstSeen,
        lastSeen: champion.lastSeen,
        sourceObservationIds,
      } satisfies StoredRule;

      const insertResult = await temple.db
        .insert(behavioralRules)
        .values({
          id: newRule.id,
          scope: newRule.scope,
          status: newRule.status,
          project: null,
          dimension: newRule.dimension,
          statement: newRule.statement,
          fingerprint: newRule.fingerprint,
          rationale: newRule.rationale,
          weight: newRule.weight,
          evidenceCount: newRule.evidenceCount,
          firstSeen: newRule.firstSeen,
          lastSeen: newRule.lastSeen,
          sourceObservationIdsJson: encodedSources,
        })
        .catch((cause) => new DatabaseQueryError({ operation: "insert promoted global rule", cause }));
      if (insertResult instanceof Error) return insertResult;

      rules.push(newRule);
    }

    promotedCount += 1;
  }

  return promotedCount;
}
