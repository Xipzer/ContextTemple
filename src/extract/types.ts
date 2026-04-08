import type { BehavioralDimension } from "../types.ts";

export const extractionCandidateKinds = ["decision", "observation", "fact", "outcome"] as const;

export type ExtractionCandidateKind = (typeof extractionCandidateKinds)[number];

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
