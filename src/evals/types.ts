export type RetrievalBenchmarkMemory = {
  id: string;
  project?: string | null;
  source?: string | null;
  content: string;
  tags?: string[];
  salience?: number;
};

export type RetrievalBenchmarkQuery = {
  id: string;
  query: string;
  project?: string | null;
  expectedMemoryIds: string[];
};

export type RetrievalBenchmarkDataset = {
  name: string;
  description: string;
  memories: RetrievalBenchmarkMemory[];
  queries: RetrievalBenchmarkQuery[];
};

export type RetrievalQueryReport = {
  queryId: string;
  query: string;
  expectedMemoryIds: string[];
  topMemoryIds: string[];
  hit: boolean;
  reciprocalRank: number;
  dcg: number;
  ndcg: number;
};

export type RetrievalModeReport = {
  mode: "lexical" | "hybrid";
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  reports: RetrievalQueryReport[];
};

export type RetrievalBenchmarkReport = {
  datasetName: string;
  topK: number;
  queryCount: number;
  lexical: RetrievalModeReport;
  hybrid: RetrievalModeReport;
  uplift: {
    recallAtK: number;
    mrr: number;
    ndcgAtK: number;
  };
};
