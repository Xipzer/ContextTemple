import * as errore from "errore";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { ensureTempleHome, type TemplePaths } from "./config.ts";
import { DatabaseBootstrapError, DatabaseOpenError } from "./errors.ts";
import * as schema from "./schema.ts";

export type TempleDatabase = {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
  paths: TemplePaths;
  close: () => Promise<void>;
};

const bootstrapStatements = [
  "PRAGMA foreign_keys = ON;",
  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    project TEXT,
    dimension TEXT NOT NULL,
    statement TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    evidence TEXT,
    confidence REAL NOT NULL,
    source_candidate_id TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS behavioral_rules (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    project TEXT,
    dimension TEXT NOT NULL,
    statement TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    rationale TEXT,
    weight REAL NOT NULL,
    evidence_count INTEGER NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    source_observation_ids_json TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS rule_conflicts (
    id TEXT PRIMARY KEY,
    left_rule_id TEXT NOT NULL,
    right_rule_id TEXT NOT NULL,
    project TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY (left_rule_id) REFERENCES behavioral_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (right_rule_id) REFERENCES behavioral_rules(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS episodic_memories (
    id TEXT PRIMARY KEY,
    project TEXT,
    source TEXT,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    keywords_json TEXT NOT NULL,
    semantic_terms_json TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    status TEXT NOT NULL,
    superseded_by_memory_id TEXT,
    salience REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER,
    access_count INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT PRIMARY KEY,
    left_memory_id TEXT NOT NULL,
    right_memory_id TEXT NOT NULL,
    project TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY (left_memory_id) REFERENCES episodic_memories(id) ON DELETE CASCADE,
    FOREIGN KEY (right_memory_id) REFERENCES episodic_memories(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS retrieval_events (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    score REAL NOT NULL,
    accepted INTEGER,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS transcript_sources (
    id TEXT PRIMARY KEY,
    project TEXT,
    source_path TEXT NOT NULL,
    source_label TEXT,
    format TEXT NOT NULL,
    checksum TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS transcript_events (
    id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    actor TEXT NOT NULL,
    event_type TEXT NOT NULL,
    name TEXT,
    content TEXT NOT NULL,
    occurred_at INTEGER,
    metadata_json TEXT NOT NULL,
    FOREIGN KEY (transcript_id) REFERENCES transcript_sources(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS extraction_runs (
    id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL,
    project TEXT,
    engine_version TEXT NOT NULL,
    candidate_count INTEGER NOT NULL,
    warnings_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (transcript_id) REFERENCES transcript_sources(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS extracted_candidates (
    id TEXT PRIMARY KEY,
    extraction_run_id TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    project TEXT,
    candidate_type TEXT NOT NULL,
    behavioral_dimension TEXT,
    statement TEXT NOT NULL,
    evidence TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_event_ids_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (extraction_run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (transcript_id) REFERENCES transcript_sources(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS promotion_runs (
    id TEXT PRIMARY KEY,
    extraction_run_id TEXT NOT NULL,
    project TEXT,
    policy_version TEXT NOT NULL,
    promoted_observation_ids_json TEXT NOT NULL,
    promoted_memory_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (extraction_run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE
  );`,
  "CREATE INDEX IF NOT EXISTS transcript_sources_checksum_idx ON transcript_sources(checksum);",
  "CREATE INDEX IF NOT EXISTS transcript_events_transcript_id_idx ON transcript_events(transcript_id, event_index);",
  "CREATE INDEX IF NOT EXISTS extraction_runs_transcript_engine_idx ON extraction_runs(transcript_id, engine_version);",
  "CREATE INDEX IF NOT EXISTS extracted_candidates_run_idx ON extracted_candidates(extraction_run_id);",
  "CREATE INDEX IF NOT EXISTS promotion_runs_extraction_policy_idx ON promotion_runs(extraction_run_id, policy_version);",
  "CREATE INDEX IF NOT EXISTS rule_conflicts_rule_ids_idx ON rule_conflicts(left_rule_id, right_rule_id);",
  "CREATE INDEX IF NOT EXISTS memory_conflicts_memory_ids_idx ON memory_conflicts(left_memory_id, right_memory_id);",
];

export async function openTempleDatabase({ homeDir }: { homeDir?: string } = {}) {
  const paths = await ensureTempleHome({ homeDir });
  if (paths instanceof Error) return paths;

  const client = errore.try({
    try: () => createClient({ url: `file:${paths.dbPath}` }),
    catch: (cause) => new DatabaseOpenError({ path: paths.dbPath, cause }),
  });
  if (client instanceof Error) return client;

  for (const statement of bootstrapStatements) {
    const bootstrapResult = await client.execute(statement).catch(
      (cause) => new DatabaseBootstrapError({ path: paths.dbPath, cause }),
    );
    if (bootstrapResult instanceof Error) {
      await closeClient(client);
      return bootstrapResult;
    }
  }

  const sourceCandidateMigration = await client.execute("ALTER TABLE observations ADD COLUMN source_candidate_id TEXT;").catch(
    (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return error.message.includes("duplicate column name") ? null : new DatabaseBootstrapError({ path: paths.dbPath, cause });
    },
  );
  if (sourceCandidateMigration instanceof Error) {
    await closeClient(client);
    return sourceCandidateMigration;
  }

  const semanticTermsMigration = await client.execute("ALTER TABLE episodic_memories ADD COLUMN semantic_terms_json TEXT;").catch(
    (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return error.message.includes("duplicate column name") ? null : new DatabaseBootstrapError({ path: paths.dbPath, cause });
    },
  );
  if (semanticTermsMigration instanceof Error) {
    await closeClient(client);
    return semanticTermsMigration;
  }

  const embeddingMigration = await client.execute("ALTER TABLE episodic_memories ADD COLUMN embedding_json TEXT;").catch(
    (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return error.message.includes("duplicate column name") ? null : new DatabaseBootstrapError({ path: paths.dbPath, cause });
    },
  );
  if (embeddingMigration instanceof Error) {
    await closeClient(client);
    return embeddingMigration;
  }

  const memoryStatusMigration = await client.execute("ALTER TABLE episodic_memories ADD COLUMN status TEXT;").catch(
    (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return error.message.includes("duplicate column name") ? null : new DatabaseBootstrapError({ path: paths.dbPath, cause });
    },
  );
  if (memoryStatusMigration instanceof Error) {
    await closeClient(client);
    return memoryStatusMigration;
  }

  const memorySupersededMigration = await client.execute("ALTER TABLE episodic_memories ADD COLUMN superseded_by_memory_id TEXT;").catch(
    (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return error.message.includes("duplicate column name") ? null : new DatabaseBootstrapError({ path: paths.dbPath, cause });
    },
  );
  if (memorySupersededMigration instanceof Error) {
    await closeClient(client);
    return memorySupersededMigration;
  }

  const semanticTermsBackfill = await client
    .execute("UPDATE episodic_memories SET semantic_terms_json = '[]' WHERE semantic_terms_json IS NULL;")
    .catch((cause) => new DatabaseBootstrapError({ path: paths.dbPath, cause }));
  if (semanticTermsBackfill instanceof Error) {
    await closeClient(client);
    return semanticTermsBackfill;
  }

  const embeddingBackfill = await client
    .execute("UPDATE episodic_memories SET embedding_json = '[]' WHERE embedding_json IS NULL;")
    .catch((cause) => new DatabaseBootstrapError({ path: paths.dbPath, cause }));
  if (embeddingBackfill instanceof Error) {
    await closeClient(client);
    return embeddingBackfill;
  }

  const memoryStatusBackfill = await client
    .execute("UPDATE episodic_memories SET status = 'active' WHERE status IS NULL;")
    .catch((cause) => new DatabaseBootstrapError({ path: paths.dbPath, cause }));
  if (memoryStatusBackfill instanceof Error) {
    await closeClient(client);
    return memoryStatusBackfill;
  }

  return {
    client,
    db: drizzle(client, { schema }),
    paths,
    close: () => closeClient(client),
  } satisfies TempleDatabase;
}

async function closeClient(client: Client) {
  const closeResult = await Promise.resolve(client.close()).catch((error) => error as Error);
  if (closeResult instanceof Error) {
    console.warn(`Failed to close ContextTemple database client: ${closeResult.message}`);
  }
}
