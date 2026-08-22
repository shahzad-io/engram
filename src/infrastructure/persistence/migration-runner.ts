import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { loadEnvFile, requireEnv } from "../env.js";

const FILENAME = /^(\d+)_.*\.sql$/u;

const TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
)
`;

export type MigrationFile = {
  version: number;
  filename: string;
  fullPath: string;
};

export type MigrateOptions = {
  connectionString?: string;
  migrationsDir?: string;
};

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Hand-written SQL, forward-only, numbered (05 §3.4, TD-18).
 * Applies pending files in numeric order and records each version.
 * There is no down path.
 */
export async function migrate(options: MigrateOptions = {}): Promise<void> {
  await loadEnvFile();
  const connectionString = options.connectionString ?? requireEnv("PKE_DATABASE_URL");
  const migrationsDir = options.migrationsDir ?? path.resolve(process.cwd(), "migrations");

  const files = await listMigrationFiles(migrationsDir);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(TRACKING_TABLE);
    const applied = await loadAppliedVersions(client);
    const pending = pendingForwardOnly(files, applied);
    if (pending.length === 0) {
      console.log("migrate: already up to date");
      return;
    }
    for (const file of pending) {
      const sql = await readFile(file.fullPath, "utf8");
      await client.query("BEGIN");
      try {
        if (sql.trim() !== "") {
          await client.query(sql);
        }
        await client.query("INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)", [
          file.version,
          file.filename,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      console.log(`migrate: applied ${file.filename}`);
    }
  } finally {
    await client.end();
  }
}

export async function listMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(migrationsDir);
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(`migrations directory not found: ${migrationsDir}`);
    }
    throw err;
  }

  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const filename of names) {
    const match = FILENAME.exec(filename);
    if (!match) continue;
    const prefix = match[1];
    if (prefix === undefined) continue;
    const version = Number.parseInt(prefix, 10);
    const existing = seen.get(version);
    if (existing !== undefined) {
      throw new Error(`duplicate migration version ${version}: ${existing} and ${filename}`);
    }
    seen.set(version, filename);
    files.push({
      version,
      filename,
      fullPath: path.join(migrationsDir, filename),
    });
  }
  files.sort((a, b) => a.version - b.version);
  assertContiguous(files);
  return files;
}

function assertContiguous(files: MigrationFile[]): void {
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file === undefined) continue;
    if (file.version !== i) {
      throw new Error(
        `migration versions must be unique and contiguous from 0; expected ${i}, found ${file.version} (${file.filename})`,
      );
    }
  }
}

async function loadAppliedVersions(client: Client): Promise<Set<number>> {
  const result = await client.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(result.rows.map((row) => row.version));
}

/**
 * Applied versions must be a prefix of the numbered files. Gaps or unknown
 * applied versions are refused; the runner never goes backwards.
 */
function pendingForwardOnly(files: MigrationFile[], applied: Set<number>): MigrationFile[] {
  const known = new Set(files.map((file) => file.version));
  for (const version of applied) {
    if (!known.has(version)) {
      throw new Error(
        `applied migration ${version} has no matching file; forward-only runner refuses to continue`,
      );
    }
  }

  const pending: MigrationFile[] = [];
  let seenUnapplied = false;
  for (const file of files) {
    const isApplied = applied.has(file.version);
    if (!isApplied) {
      seenUnapplied = true;
      pending.push(file);
    } else if (seenUnapplied) {
      throw new Error(
        `migration ${file.version} is applied but an earlier file is not; forward-only runner refuses to continue`,
      );
    }
  }
  return pending;
}
