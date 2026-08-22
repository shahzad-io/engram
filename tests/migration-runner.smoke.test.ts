import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { waitForDatabase, withClient } from "./support/db.ts";

const execFileAsync = promisify(execFile);

test("migration runner connects and the test command works", async () => {
  await waitForDatabase();

  await execFileAsync("node", ["dist/cli.js", "migrate"], {
    env: { ...process.env },
  });

  await withClient(async (client) => {
    const result = await client.query<{ version: number; filename: string }>(
      "SELECT version, filename FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      result.rows.map((row) => ({ version: row.version, filename: row.filename })),
      [
        { version: 0, filename: "000_graph_versions.sql" },
        { version: 1, filename: "001_scopes.sql" },
        { version: 2, filename: "002_feature_labels.sql" },
        { version: 3, filename: "003_knowledge_objects.sql" },
        { version: 4, filename: "004_relations.sql" },
        { version: 5, filename: "005_relation_legality.sql" },
        { version: 6, filename: "006_triggers_invariants.sql" },
        { version: 7, filename: "007_delete_guards_and_indexes.sql" },
        { version: 8, filename: "008_fix_append_only_generated_column.sql" },
        { version: 9, filename: "009_approval_is_insert_only.sql" },
        { version: 10, filename: "010_transitive_requirement_impact.sql" },
        { version: 11, filename: "011_candidates.sql" },
        { version: 12, filename: "012_retrieval_and_packs.sql" },
        { version: 13, filename: "013_repair_approval_immutability.sql" },
        { version: 14, filename: "014_backfill_provenance_mode.sql" },
        { version: 15, filename: "015_feature_label_relabeling.sql" },
        { version: 16, filename: "016_graph_identity_prefixes.sql" },
        { version: 17, filename: "017_retracted_status.sql" },
        { version: 18, filename: "018_retracted_status_constraints.sql" },
        { version: 19, filename: "019_retraction_requirement_impact.sql" },
        { version: 20, filename: "020_instrumentation.sql" },
      ],
    );
  });
});
