import type { BehavioralDimension } from "../types.ts";

export const extractionCandidateKinds = ["decision", "observation", "fact", "outcome"] as const;

export type ExtractionCandidateKind = (typeof extractionCandidateKinds)[number];
export type ExtractionCandidateReviewStatus = "pending" | "approved" | "rejected" | "promoted";

export type ExtractionRun = {
  id: string;
  transcriptId: string;
  project: string | null;
  engineVersion: string;
  candidateCount: number;
  warnings: string[];
  createdAt: Date;
};

export type StoredExtractionCandidate = {
  id: string;
  extractionRunId: string;
  transcriptId: string;
  project: string | null;
  candidateType: ExtractionCandidateKind;
  behavioralDimension: BehavioralDimension | null;
  statement: string;
  evidence: string;
  confidence: number;
  sourceEventIds: string[];
  metadata: Record<string, unknown>;
  reviewStatus: ExtractionCandidateReviewStatus;
  reviewNote: string | null;
  reviewedAt: Date | null;
  promotedAt: Date | null;
  createdAt: Date;
};

export type TranscriptExtractionResult = {
  duplicate: boolean;
  run: ExtractionRun;
  candidates: StoredExtractionCandidate[];
};

export type PromotionRun = {
  id: string;
  extractionRunId: string;
  project: string | null;
  policyVersion: string;
  promotedObservationIds: string[];
  promotedMemoryIds: string[];
  createdAt: Date;
};

export type PromotionResult = {
  duplicate: boolean;
  run: PromotionRun;
  promotedObservationIds: string[];
  promotedMemoryIds: string[];
  skippedCandidateIds: string[];
};

export type ExtractionCandidateDraft = {
  candidateType: ExtractionCandidateKind;
  behavioralDimension: BehavioralDimension | null;
  statement: string;
  evidence: string;
  confidence: number;
  sourceEventIds: string[];
  metadata: Record<string, unknown>;
};

export type ExtractionCandidateCluster = {
  id: string;
  project: string | null;
  label: string;
  candidateIds: string[];
  similarity: number;
};
