#!/usr/bin/env node
// Guarded runner for hand-written ADDITIVE SQL (new tables, columns, indexes, enum values) against a
// disposable local database. Benchmark and production databases are refused by assert-safe-database.mjs.
//
//   pnpm --filter @workspace/db run apply-sql -- <file.sql>          check, then apply in one transaction
//   pnpm --filter @workspace/db run apply-sql -- --check <file.sql>  check only, no database connection
//
// Accepted statements: CREATE TABLE, CREATE [UNIQUE] INDEX, CREATE EXTENSION IF NOT EXISTS, CREATE TYPE,
// CREATE SEQUENCE, ALTER TABLE ... ADD ..., ALTER TYPE ... ADD VALUE, COMMENT ON TABLE/COLUMN/INDEX/TYPE.
// Refused anywhere: DROP, TRUNCATE, DELETE, UPDATE, RENAME, REPLACE (foreign-key ON DELETE/ON UPDATE
// actions excepted), block comments, dollar quoting (DO blocks, function bodies) and E'' strings, because
// they would hide statements from this check. After applying, the Drizzle schema must describe the same
// objects; check with a guarded push (docs/DEVELOPMENT.md lists the statements drizzle-kit always re-emits).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeDatabase, DatabaseGuardRefusal, MODES, runGuarded } from "./assert-safe-database.mjs";

function refuse(message) {
  throw new DatabaseGuardRefusal(message);
}

/** Splits SQL into statements, blanking string literals and quoted identifiers for keyword checks. */
function lexStatements(text) {
  const statements = [];
  let masked = "";
  let start = 0;
  let i = 0;
  const flush = (end) => {
    const source = text.slice(start, end).trim();
    if (masked.trim()) statements.push({ source, masked });
    masked = "";
    start = end + 1;
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === "/" && next === "*") refuse("block comments are refused (they can hide statements); use -- comments");
    if (ch === "$") refuse("dollar quoting (DO blocks, function bodies) is refused");
    if (ch === "'") {
      if (/[eE]/.test(text[i - 1] ?? "") && !/[\w$]/.test(text[i - 2] ?? "")) refuse("E'' escape strings are refused");
      let j = i + 1;
      for (;;) {
        if (j >= text.length) refuse("unterminated string literal");
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j += 1;
      }
      masked += "''";
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) refuse("unterminated quoted identifier");
        if (text[j] === '"' && text[j + 1] === '"') j += 2;
        else if (text[j] === '"') break;
        else j += 1;
      }
      masked += '"_"';
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      flush(i);
      i += 1;
      continue;
    }
    masked += ch;
    i += 1;
  }
  flush(text.length);
  return statements;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

const IDENT = String.raw`(?:"_"|[A-Z_][\w]*)(?:\.(?:"_"|[A-Z_][\w]*))?`;
const ALTER_TABLE = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${IDENT} (.+)$`);
const ALLOWED_STATEMENTS = [
  /^CREATE TABLE /,
  /^CREATE (?:UNIQUE )?INDEX /,
  /^CREATE EXTENSION IF NOT EXISTS /,
  /^CREATE TYPE /,
  /^CREATE SEQUENCE /,
  new RegExp(String.raw`^ALTER TYPE ${IDENT} ADD VALUE `),
  /^COMMENT ON (?:TABLE|COLUMN|INDEX|TYPE) /,
];
const FK_ACTION = /\bON (?:DELETE|UPDATE) (?:CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT)\b/g;
const FORBIDDEN = /\b(DROP|TRUNCATE|DELETE|UPDATE|RENAME|REPLACE)\b/;

/** Returns the statements of an additive SQL file, or throws a DatabaseGuardRefusal naming the first problem. */
export function checkAdditiveSql(text) {
  const statements = lexStatements(text);
  if (!statements.length) refuse("the SQL file contains no statements");
  statements.forEach(({ masked }, index) => {
    const normalized = masked.replace(/\s+/g, " ").trim().toUpperCase();
    const label = `statement ${index + 1} (${normalized.slice(0, 60)}${normalized.length > 60 ? "..." : ""})`;
    const forbidden = FORBIDDEN.exec(normalized.replace(FK_ACTION, " "));
    if (forbidden) refuse(`${label}: ${forbidden[1]} is refused; only additive changes are allowed`);
    if (/\bCONCURRENTLY\b/.test(normalized)) refuse(`${label}: CONCURRENTLY cannot run inside the transaction`);
    const alterTable = ALTER_TABLE.exec(normalized);
    if (alterTable) {
      const nonAdditive = splitTopLevel(alterTable[1]).find((action) => !action.startsWith("ADD "));
      if (nonAdditive) refuse(`${label}: ALTER TABLE action "${nonAdditive.slice(0, 40)}" is not additive; only ADD is allowed`);
      return;
    }
    if (!ALLOWED_STATEMENTS.some((pattern) => pattern.test(normalized))) {
      refuse(`${label}: not an accepted additive statement`);
    }
  });
  return statements.map(({ source }) => source);
}

async function main() {
  // `pnpm run apply-sql -- <file>` passes the "--" separator through.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const checkOnly = args.includes("--check");
  const files = args.filter((arg) => arg !== "--check");
  if (files.length !== 1 || files[0].startsWith("-")) refuse("usage: apply-sql.mjs [--check] <file.sql>");
  // pnpm runs package scripts in lib/db; resolve a relative path against the directory pnpm was started in.
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), files[0]);
  const statements = checkAdditiveSql(await readFile(file, "utf8"));
  console.log(`[db-guard] ${statements.length} additive statement(s) accepted from ${file}`);
  if (checkOnly) return 0;

  const { client } = await assertSafeDatabase({ mode: MODES.disposable });
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
  console.log("[db-guard] applied in one transaction; now check the schema with the guarded push (see docs/DEVELOPMENT.md)");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runGuarded(main);
}
