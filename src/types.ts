export const behavioralDimensions = [
  "guard",
  "style",
  "workflow",
  "preference",
  "failure",
] as const;

export type BehavioralDimension = (typeof behavioralDimensions)[number];
export type RuleScope = "global" | "project";
export type RuleStatus = "active" | "retired" | "conflicted";
export type MemoryStatus = "active" | "superseded" | "archived" | "conflicted";

export type ObservationInput = {
  project?: string | null;
  dimension: BehavioralDimension;
  statement: string;
  evidence?: string | null;
  confidence?: number;
  sourceCandidateId?: string | null;
};

export type MemoryInput = {
  project?: string | null;
  source?: string | null;
  content: string;
  tags?: string[];
  salience?: number;
};

export type StoredObservation = {
  id: string;
  project: string | null;
  dimension: BehavioralDimension;
  statement: string;
  fingerprint: string;
  evidence: string | null;
  confidence: number;
  sourceCandidateId: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

export type StoredRule = {
  id: string;
  scope: RuleScope;
  status: RuleStatus;
  project: string | null;
  dimension: BehavioralDimension;
  statement: string;
  fingerprint: string;
  rationale: string | null;
  weight: number;
  evidenceCount: number;
  firstSeen: Date;
  lastSeen: Date;
  sourceObservationIds: string[];
};

export type StoredRuleConflict = {
  id: string;
  leftRuleId: string;
  rightRuleId: string;
  project: string | null;
  reason: string;
  status: "open" | "resolved";
  createdAt: Date;
  resolvedAt: Date | null;
};

export type StoredMemory = {
  id: string;
  project: string | null;
  source: string | null;
  content: string;
  summary: string;
  tags: string[];
  keywords: string[];
  semanticTerms: string[];
  status: MemoryStatus;
  supersededByMemoryId: string | null;
  salience: number;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
  accessCount: number;
};

export type StoredMemoryConflict = {
  id: string;
  leftMemoryId: string;
  rightMemoryId: string;
  project: string | null;
  reason: string;
  status: "open" | "resolved";
  createdAt: Date;
  resolvedAt: Date | null;
};

export type MemoryScoreBreakdown = {
  lexical: number;
  semantic: number;
  phrase: number;
  tag: number;
  recency: number;
  salience: number;
  rerank: number;
  total: number;
};

export type MemorySearchResult = StoredMemory & {
  score: number;
  retrievalId: string;
  scoreBreakdown: MemoryScoreBreakdown;
};

export type ConsolidationReport = {
  processedObservations: number;
  insertedRules: number;
  updatedRules: number;
  promotedRules: number;
  retiredRules: number;
  conflictedRules: number;
  resolvedRuleConflicts: number;
};

export type BehavioralContextSnapshot = {
  markdown: string;
  rules: StoredRule[];
};

export type EpisodicContextSnapshot = {
  markdown: string;
  memories: MemorySearchResult[];
};

export type StartupContext = {
  markdown: string;
  project: string | null;
  query: string | null;
  rules: StoredRule[];
  memories: MemorySearchResult[];
};

export type TempleStatus = {
  observations: number;
  activeRules: number;
  episodicMemories: number;
  retrievalEvents: number;
  transcripts: number;
  transcriptEvents: number;
  extractionRuns: number;
  extractedCandidates: number;
  promotionRuns: number;
  ruleConflicts: number;
  memoryConflicts: number;
};
