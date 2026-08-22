import { Client } from "pg";
import { migrate } from "../../dist/infrastructure/persistence/migration-runner.js";

const configuredDatabaseUrl =
  process.env.PKE_DATABASE_URL ?? "postgres://pke:pke_local@127.0.0.1:5433/pke";

function assertThrowawayDatabase(connectionString: string): void {
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  } catch {
    throw new Error("Tests require a PostgreSQL URL for their throwaway database");
  }
  if (!databaseName.startsWith("pke_test_")) {
    throw new Error(
      "Tests must run through npm test so they cannot write to the real graph database",
    );
  }
}

assertThrowawayDatabase(configuredDatabaseUrl);
export const DATABASE_URL = configuredDatabaseUrl;

export async function waitForDatabase(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let throwawaySequence = 0;

export async function withFreshThrowawayDatabase<T>(
  fn: (client: Client, connectionString: string) => Promise<T>,
): Promise<T> {
  throwawaySequence += 1;
  const name = `pke_test_a20_${process.pid}_${Date.now()}_${throwawaySequence}`;
  const parsed = new URL(DATABASE_URL);
  parsed.pathname = `/${name}`;
  const connectionString = parsed.toString();
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  await admin.end();
  try {
    await migrate({ connectionString });
    const client = new Client({ connectionString });
    await client.connect();
    try {
      return await fn(client, connectionString);
    } finally {
      await client.end();
    }
  } finally {
    const cleanup = new Client({ connectionString: DATABASE_URL });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE "${name.replaceAll('"', '""')}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
}

export function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
