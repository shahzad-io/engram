/**
 * Reproduces every stored pack and prints one stable line each, for
 * before/after comparison across a schema migration. Read-only.
 *
 * Deliberately excludes anything that varies with wall-clock (`built_at`,
 * staleness evaluated_at) so a difference in the output means a difference in
 * selection, hash, or verdict — not that time passed between the two runs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ids = readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "built_at" && key !== "evaluated_at")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

for (const id of ids) {
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", ["dist/cli.js", "pack", "reproduce", id, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    exitCode = error.status ?? -1;
    stdout = error.stdout ?? "";
  }

  let line;
  try {
    const envelope = JSON.parse(stdout);
    const data = envelope.data ?? {};
    const recipe = data.pack?.recipe ?? {};
    const diagnostics = [
      ...(data.limitations ?? []),
      ...(envelope.error?.details?.limitations ?? []),
    ]
      .map((entry) => entry.code ?? entry)
      .sort();
    line = [
      id,
      `exit=${exitCode}`,
      `error=${envelope.error?.code ?? "-"}`,
      `gv=${envelope.graph_version ?? "-"}`,
      `recipe_gv=${recipe.graph_version ?? "-"}`,
      `hash=${(recipe.content_hash ?? "-").slice(0, 16)}`,
      `objects=${(recipe.ordered_object_ids ?? []).length}`,
      `dropped=${(recipe.dropped_object_ids ?? []).length}`,
      `limitations=${diagnostics.join(",") || "-"}`,
      // Hash of the whole envelope minus clock-dependent fields, so a change
      // the named fields above would miss still shows up.
      `body=${createHash("md5").update(JSON.stringify(stable(envelope))).digest("hex").slice(0, 16)}`,
    ].join(" ");
  } catch {
    line = `${id} exit=${exitCode} UNPARSEABLE ${JSON.stringify(stdout.slice(0, 200))}`;
  }
  console.log(line);
}
