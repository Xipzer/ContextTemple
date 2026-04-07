import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { BehavioralDimension, RuleScope, RuleStatus } from "./types.ts";

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  project: text("project"),
  dimension: text("dimension").$type<BehavioralDimension>().notNull(),
  statement: text("statement").notNull(),
  fingerprint: text("fingerprint").notNull(),
  evidence: text("evidence"),
  confidence: real("confidence").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }),
});

export const behavioralRules = sqliteTable("behavioral_rules", {
  id: text("id").primaryKey(),
  scope: text("scope").$type<RuleScope>().notNull(),
  status: text("status").$type<RuleStatus>().notNull(),
  project: text("project"),
  dimension: text("dimension").$type<BehavioralDimension>().notNull(),
  statement: text("statement").notNull(),
  fingerprint: text("fingerprint").notNull(),
  rationale: text("rationale"),
  weight: real("weight").notNull(),
  evidenceCount: integer("evidence_count").notNull(),
  firstSeen: integer("first_seen", { mode: "timestamp_ms" }).notNull(),
  lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
  sourceObservationIdsJson: text("source_observation_ids_json").notNull(),
});

export const episodicMemories = sqliteTable("episodic_memories", {
  id: text("id").primaryKey(),
  project: text("project"),
  source: text("source"),
  content: text("content").notNull(),
  summary: text("summary").notNull(),
  tagsJson: text("tags_json").notNull(),
  keywordsJson: text("keywords_json").notNull(),
  salience: real("salience").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp_ms" }),
  accessCount: integer("access_count").notNull(),
});

export const retrievalEvents = sqliteTable("retrieval_events", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  memoryId: text("memory_id").notNull(),
  score: real("score").notNull(),
  accepted: integer("accepted", { mode: "boolean" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
