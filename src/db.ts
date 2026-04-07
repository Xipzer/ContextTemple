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
  `CREATE TABLE IF NOT EXISTS episodic_memories (
    id TEXT PRIMARY KEY,
    project TEXT,
    source TEXT,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    keywords_json TEXT NOT NULL,
    salience REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER,
    access_count INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS retrieval_events (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    score REAL NOT NULL,
    accepted INTEGER,
    created_at INTEGER NOT NULL
  );`,
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
