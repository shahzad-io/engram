/**
 * The two boundaries in 05 §7 and §4.4 are lint rules rather than
 * discipline, which means the lint rules themselves are load-bearing.
 * A rule that silently stopped matching — a renamed directory, a
 * config that no longer loads, a selector that no longer fires — would
 * look exactly like a clean run. These tests make each rule fail on
 * purpose, through the real `eslint.config.js`, so "lint passed" keeps
 * meaning something.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIdsFor(filePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).flatMap((message) =>
    message.ruleId === null ? [] : [message.ruleId],
  );
}

describe("domain boundary", () => {
  it("rejects a database driver in the domain layer", async () => {
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import { Client } from "pg";\nexport type Probe = Client;\n',
    );
    assert.ok(ruleIds.includes("pke/domain-boundary"));
  });

  it("rejects reaching into infrastructure, mcp, or cli", async () => {
    for (const specifier of [
      "../infrastructure/persistence/read.js",
      "../mcp/envelope.js",
      "../cli.js",
    ]) {
      const ruleIds = await ruleIdsFor(
        "src/domain/probe.ts",
        `import { probe } from "${specifier}";\nexport const value = probe;\n`,
      );
      assert.ok(
        ruleIds.includes("pke/domain-boundary"),
        `importing ${specifier} from src/domain/ was not reported`,
      );
    }
  });

  it("permits the node builtins the domain layer is allowed", async () => {
    const ruleIds = await ruleIdsFor(
      "src/domain/probe.ts",
      'import { createHash } from "node:crypto";\nexport const value = createHash;\n',
    );
    assert.ok(!ruleIds.includes("pke/domain-boundary"));
  });
});

describe("mcp write boundary", () => {
  it("rejects any module under src/application/write/", async () => {
    for (const specifier of [
      "../application/write/index.js",
      "../application/write/candidates.js",
      "../application/write/transaction.js",
    ]) {
      const ruleIds = await ruleIdsFor(
        "src/mcp/probe.ts",
        `import { probe } from "${specifier}";\nexport const value = probe;\n`,
      );
      assert.ok(
        ruleIds.includes("pke/mcp-no-write"),
        `importing ${specifier} from src/mcp/ was not reported`,
      );
    }
  });

  it("rejects a write use case named outside that directory", async () => {
    for (const name of ["approve", "supersede", "verify", "retract", "triage"]) {
      const ruleIds = await ruleIdsFor(
        "src/mcp/probe.ts",
        `import { probe } from "../application/${name}.js";\nexport const value = probe;\n`,
      );
      assert.ok(
        ruleIds.includes("pke/mcp-no-write"),
        `importing a module named "${name}" from src/mcp/ was not reported`,
      );
    }
  });

  it("permits the read and propose paths the agent surface needs", async () => {
    const ruleIds = await ruleIdsFor(
      "src/mcp/probe.ts",
      'import { probe } from "../application/read/index.js";\nexport const value = probe;\n',
    );
    assert.ok(!ruleIds.includes("pke/mcp-no-write"));
  });
});

describe("backfill boundary", () => {
  it("rejects the backfill transaction capability outside the importer", async () => {
    const dedicated = await ruleIdsFor(
      "src/application/propose/probe.ts",
      'import { backfillCurationTransaction } from "../write/backfill.js";\n' +
        "export const value = backfillCurationTransaction;\n",
    );
    const viaTransaction = await ruleIdsFor(
      "src/application/propose/probe.ts",
      'import { backfillCurationTransaction } from "../write/transaction.js";\n' +
        "export const value = backfillCurationTransaction;\n",
    );

    assert.ok(dedicated.includes("pke/backfill-boundary"));
    assert.ok(viaTransaction.includes("pke/backfill-boundary"));
  });

  it("permits the backfill importer itself", async () => {
    const ruleIds = await ruleIdsFor(
      "src/application/backfill/probe.ts",
      'import { backfillCurationTransaction } from "../write/backfill.js";\n' +
        "export const value = backfillCurationTransaction;\n",
    );
    assert.ok(!ruleIds.includes("pke/backfill-boundary"));
  });
});
