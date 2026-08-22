import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after } from "node:test";
import { Client } from "pg";
import { migrate } from "../../dist/infrastructure/persistence/migration-runner.js";

const DEFAULT_DATABASE_URL = "postgres://pke:pke_local@127.0.0.1:5433/pke";
const baseDatabaseUrl = process.env.PKE_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const originalDatabaseUrl = process.env.PKE_DATABASE_URL;
const testDatabaseName = `pke_test_${process.pid}_${Date.now()}`;

function databaseUrlFor(name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseDatabaseUrl);
  } catch {
    throw new Error(
      "npm test requires PKE_DATABASE_URL to be a PostgreSQL URL so its throwaway database can be provisioned",
    );
  }
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function createDatabase(): Promise<string> {
  const admin = new Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
  } finally {
    await admin.end();
  }
  return databaseUrlFor(testDatabaseName);
}

async function dropDatabase(): Promise<void> {
  const admin = new Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE ${quoteIdentifier(testDatabaseName)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

const testDatabaseUrl = await createDatabase();
try {
  process.env.PKE_DATABASE_URL = testDatabaseUrl;
  await migrate({ connectionString: testDatabaseUrl });
  const bootstrapClient = new Client({ connectionString: testDatabaseUrl });
  await bootstrapClient.connect();
  try {
    await bootstrapClient.query(
      "INSERT INTO graph_versions (action, actor, object_ids) VALUES ($1, $2, ARRAY[]::text[])",
      ["test.bootstrap", "system"],
    );
  } finally {
    await bootstrapClient.end();
  }
} catch (error) {
  await dropDatabase();
  throw error;
}

const testDirectory = path.resolve(process.cwd(), "tests");
const testFiles = (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.ts"))
  .sort((left, right) => left.localeCompare(right));

for (const testFile of testFiles) {
  await import(pathToFileURL(path.join(testDirectory, testFile)).href);
}

let cleaned = false;
after(async () => {
  if (cleaned) return;
  cleaned = true;
  await dropDatabase();
  if (originalDatabaseUrl === undefined) {
    delete process.env.PKE_DATABASE_URL;
  } else {
    process.env.PKE_DATABASE_URL = originalDatabaseUrl;
  }
});
