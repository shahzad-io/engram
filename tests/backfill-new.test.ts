import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { BACKFILL_TYPE_SPECS } from "../dist/domain/backfill/spec.js";

const execFileAsync = promisify(execFile);

function parseGeneratedObject(text: string): Record<string, unknown> {
  const withoutHeader = text.replace(/^\/\/ Initial status: [a-z_]+\n/u, "");
  return JSON.parse(withoutHeader) as Record<string, unknown>;
}

test("backfill new creates a typed skeleton with the initial status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pke-backfill-new-"));
  try {
    const cliPath = path.resolve("dist/cli.js");
    await execFileAsync(process.execPath, [cliPath, "backfill", "new", "decision"], {
      cwd: directory,
      env: process.env,
    });
    const generatedPath = path.join(directory, "backfill", "beacon", "objects", "DEC-0001.json");
    const text = await readFile(generatedPath, "utf8");
    assert.match(text, /^\/\/ Initial status: active\n/u);
    assert.deepEqual(parseGeneratedObject(text), {
      id: "DEC-0001",
      type: "decision",
      scope_id: "",
      feature_labels: [],
      title: "",
      body: "",
      status: "active",
      attributes: {
        statement: "",
        rationale: "",
        reversibility: "",
        alternatives_rejected: [],
      },
    });

    await execFileAsync(process.execPath, [cliPath, "backfill", "new", "decision"], {
      cwd: directory,
      env: process.env,
    });
    assert.match(
      await readFile(path.join(directory, "backfill", "beacon", "objects", "DEC-0002.json"), "utf8"),
      /^\/\/ Initial status: active\n/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill new exposes the required keys for every knowledge-object type", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pke-backfill-new-all-"));
  try {
    const cliPath = path.resolve("dist/cli.js");
    for (const [type, spec] of Object.entries(BACKFILL_TYPE_SPECS)) {
      const id = `${spec.idPrefix}-9000`;
      await execFileAsync(process.execPath, [cliPath, "backfill", "new", type, "--id", id], {
        cwd: directory,
        env: process.env,
      });
      const generatedPath = path.join(directory, "backfill", "beacon", "objects", `${id}.json`);
      const object = parseGeneratedObject(await readFile(generatedPath, "utf8"));
      assert.equal(object.type, type);
      assert.equal(object.status, spec.initialStatus);
      assert.deepEqual(
        Object.keys(object.attributes as Record<string, unknown>).sort(),
        [...spec.requiredAttributes].sort(),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
