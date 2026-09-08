#!/usr/bin/env node
// Ensures Postgres extensions the tracked schema depends on exist before
// drizzle-kit push runs. drizzle-kit manages tables/indexes/columns but has
// no concept of `CREATE EXTENSION`, so a schema that declares GIN trigram
// indexes (`.using("gin", sql`${column} gin_trgm_ops`)`) will fail to push
// against a fresh database unless pg_trgm is created first. Idempotent and
// safe to run on every push, including against an already-provisioned dev
// database that already has the extension.
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

const REQUIRED_EXTENSIONS = ["pg_trgm"];

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const extension of REQUIRED_EXTENSIONS) {
    await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    console.log(`[ensure-extensions] ${extension} is enabled`);
  }
} finally {
  await client.end();
}
