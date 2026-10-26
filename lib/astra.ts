/**
 * astra.ts
 *
 * Singleton Astra DB handle plus the embedding constants the wiki collections
 * are built around. Env is read lazily on first use, never at module scope.
 *
 * The wiki shares an Astra database with Walfly for now, but not any code:
 * this file is deliberately a copy, not an import of @walfly/db.
 */

import { DataAPIClient, type Db } from '@datastax/astra-db-ts';

/** Astra vectorize model pinned per collection; changing it means a new collection. */
export const VECTOR_MODEL = 'nvidia/nv-embedqa-e5-v5';
export const VECTOR_DIMENSION = 1024;
/** nv-embedqa-e5-v5 caps input at 512 tokens; ~750 chars is a safe bound (~3.5 chars/token average). */
export const VECTORIZE_MAX_CHARS = 750;

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;

  const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
  const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
  if (!endpoint || !token) {
    throw new Error('Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN env vars');
  }

  // Explicit timeouts so a hung Data API call fails fast instead of holding a
  // request open until the platform kills it.
  const client = new DataAPIClient(token, {
    timeoutDefaults: { requestTimeoutMs: 20_000, generalMethodTimeoutMs: 45_000 },
  });

  db = client.db(endpoint, process.env.ASTRA_DB_KEYSPACE ? { keyspace: process.env.ASTRA_DB_KEYSPACE } : undefined);
  return db;
}
