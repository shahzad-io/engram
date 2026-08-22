import { readFile } from "node:fs/promises";

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Loads `.env` from cwd into process.env without overwriting existing values.
 * 05 §5.4: all configuration comes from environment variables.
 */
export async function loadEnvFile(filePath = ".env"): Promise<void> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
