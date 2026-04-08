export type RuntimeSeedTranscript = {
  path: string;
  project: string;
};

export type RuntimeBenchmarkCase = {
  id: string;
  project: string;
  message: string;
  expectedRuleSubstrings?: string[];
  expectedMemorySubstrings?: string[];
};

export type RuntimeBenchmarkDataset = {
  name: string;
  description: string;
  seedTranscripts: RuntimeSeedTranscript[];
  behavioralCases: RuntimeBenchmarkCase[];
  calibrationCases: RuntimeBenchmarkCase[];
};

export type RuntimeCaseReport = {
  caseId: string;
  project: string;
  message: string;
  expectedRuleSubstrings: string[];
  expectedMemorySubstrings: string[];
  matchedRules: string[];
  matchedMemories: string[];
  success: boolean;
};

export type RuntimeBenchmarkModeReport = {
  mode: "no-memory" | "startup-only" | "full-system";
  score: number;
  reports: RuntimeCaseReport[];
};

export type BehavioralReplayReport = {
  datasetName: string;
  noMemory: RuntimeBenchmarkModeReport;
  fullSystem: RuntimeBenchmarkModeReport;
  improvement: number;
};

export type FirstResponseCalibrationReport = {
  datasetName: string;
  startupOnly: RuntimeBenchmarkModeReport;
  fullSystem: RuntimeBenchmarkModeReport;
  improvement: number;
};

export type LocalModelUpliftReport = {
  behavioralReplayImprovement: number;
  firstResponseImprovement: number;
  retrievalNdcgImprovement: number;
  compositeImprovement: number;
};
