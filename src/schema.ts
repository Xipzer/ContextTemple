import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { ExtractionCandidateKind } from "./extract/types.ts";
import type { TranscriptActor, TranscriptEventType, TranscriptFormat } from "./ingest/types.ts";
import type { BehavioralDimension, EmbeddingProviderName, MemoryStatus, RuleScope, RuleStatus } from "./types.ts";
import type { ExtractionCandidateReviewStatus } from "./extract/types.ts";

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  project: text("project"),
  dimension: text("dimension").$type<BehavioralDimension>().notNull(),
  statement: text("statement").notNull(),
  fingerprint: text("fingerprint").notNull(),
  evidence: text("evidence"),
  confidence: real("confidence").notNull(),
  sourceCandidateId: text("source_candidate_id"),
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

export const ruleConflicts = sqliteTable("rule_conflicts", {
  id: text("id").primaryKey(),
  leftRuleId: text("left_rule_id")
    .notNull()
    .references(() => behavioralRules.id, { onDelete: "cascade" }),
  rightRuleId: text("right_rule_id")
    .notNull()
    .references(() => behavioralRules.id, { onDelete: "cascade" }),
  project: text("project"),
  reason: text("reason").notNull(),
  status: text("status").$type<"open" | "resolved">().notNull(),
  resolutionAction: text("resolution_action"),
  resolutionNote: text("resolution_note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});

export const episodicMemories = sqliteTable("episodic_memories", {
  id: text("id").primaryKey(),
  project: text("project"),
  source: text("source"),
  content: text("content").notNull(),
  summary: text("summary").notNull(),
  tagsJson: text("tags_json").notNull(),
  keywordsJson: text("keywords_json").notNull(),
  semanticTermsJson: text("semantic_terms_json").notNull(),
  embeddingJson: text("embedding_json").notNull(),
  embeddingProvider: text("embedding_provider").$type<EmbeddingProviderName>().notNull(),
  embeddingModel: text("embedding_model"),
  status: text("status").$type<MemoryStatus>().notNull(),
  supersededByMemoryId: text("superseded_by_memory_id"),
  salience: real("salience").notNull(),
  positiveFeedbackCount: integer("positive_feedback_count").notNull(),
  negativeFeedbackCount: integer("negative_feedback_count").notNull(),
  usefulnessScore: real("usefulness_score").notNull(),
  lastFeedbackAt: integer("last_feedback_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp_ms" }),
  accessCount: integer("access_count").notNull(),
});

export const memoryConflicts = sqliteTable("memory_conflicts", {
  id: text("id").primaryKey(),
  leftMemoryId: text("left_memory_id")
    .notNull()
    .references(() => episodicMemories.id, { onDelete: "cascade" }),
  rightMemoryId: text("right_memory_id")
    .notNull()
    .references(() => episodicMemories.id, { onDelete: "cascade" }),
  project: text("project"),
  reason: text("reason").notNull(),
  status: text("status").$type<"open" | "resolved">().notNull(),
  resolutionAction: text("resolution_action"),
  resolutionNote: text("resolution_note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});

export const retrievalEvents = sqliteTable("retrieval_events", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  memoryId: text("memory_id").notNull(),
  score: real("score").notNull(),
  accepted: integer("accepted", { mode: "boolean" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const transcriptSources = sqliteTable("transcript_sources", {
  id: text("id").primaryKey(),
  project: text("project"),
  sourcePath: text("source_path").notNull(),
  sourceLabel: text("source_label"),
  format: text("format").$type<TranscriptFormat>().notNull(),
  checksum: text("checksum").notNull(),
  eventCount: integer("event_count").notNull(),
  importedAt: integer("imported_at", { mode: "timestamp_ms" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
});

export const transcriptEvents = sqliteTable("transcript_events", {
  id: text("id").primaryKey(),
  transcriptId: text("transcript_id")
    .notNull()
    .references(() => transcriptSources.id, { onDelete: "cascade" }),
  eventIndex: integer("event_index").notNull(),
  actor: text("actor").$type<TranscriptActor>().notNull(),
  eventType: text("event_type").$type<TranscriptEventType>().notNull(),
  name: text("name"),
  content: text("content").notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }),
  metadataJson: text("metadata_json").notNull(),
});

export const extractionRuns = sqliteTable("extraction_runs", {
  id: text("id").primaryKey(),
  transcriptId: text("transcript_id")
    .notNull()
    .references(() => transcriptSources.id, { onDelete: "cascade" }),
  project: text("project"),
  engineVersion: text("engine_version").notNull(),
  candidateCount: integer("candidate_count").notNull(),
  warningsJson: text("warnings_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const extractedCandidates = sqliteTable("extracted_candidates", {
  id: text("id").primaryKey(),
  extractionRunId: text("extraction_run_id")
    .notNull()
    .references(() => extractionRuns.id, { onDelete: "cascade" }),
  transcriptId: text("transcript_id")
    .notNull()
    .references(() => transcriptSources.id, { onDelete: "cascade" }),
  project: text("project"),
  candidateType: text("candidate_type").$type<ExtractionCandidateKind>().notNull(),
  behavioralDimension: text("behavioral_dimension").$type<BehavioralDimension>(),
  statement: text("statement").notNull(),
  evidence: text("evidence").notNull(),
  confidence: real("confidence").notNull(),
  sourceEventIdsJson: text("source_event_ids_json").notNull(),
  metadataJson: text("metadata_json").notNull(),
  reviewStatus: text("review_status").$type<ExtractionCandidateReviewStatus>().notNull(),
  reviewNote: text("review_note"),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  promotedAt: integer("promoted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const promotionRuns = sqliteTable("promotion_runs", {
  id: text("id").primaryKey(),
  extractionRunId: text("extraction_run_id")
    .notNull()
    .references(() => extractionRuns.id, { onDelete: "cascade" }),
  project: text("project"),
  policyVersion: text("policy_version").notNull(),
  promotedObservationIdsJson: text("promoted_observation_ids_json").notNull(),
  promotedMemoryIdsJson: text("promoted_memory_ids_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
