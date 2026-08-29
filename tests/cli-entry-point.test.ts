import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

type Invocation = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Runs the CLI in a subprocess. Unlike every other CLI test here, which calls
 * `runCli` directly, this one has to spawn: the behaviour under test is the
 * module-level entry-point guard, which only runs when the file is executed as
 * a program, and `process.argv[1]` is the input that decides it.
 */
async function invoke(scriptPath: string, args: readonly string[]): Promise<Invocation> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [scriptPath, ...args], {
      // `--help` is answered without touching the database, which keeps this
      // test independent of the shared throwaway graph.
      env: { ...process.env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

// The guard compared path.resolve(process.argv[1]) with the real module path.
// path.resolve does not resolve symlinks, so every symlinked invocation failed
// the comparison, ran nothing, and exited 0 with no output. That is the
// installed path: package.json declares bin.pke, so npm link or a global
// install puts a symlink on PATH, and the usage text says to run `pke migrate`.
// Measured before the fix: `pke migrate` through the symlink produced zero
// bytes and exited 0, leaving the database unmigrated while reporting success.
//
// Asserting equality against the direct invocation rather than against fixed
// expected text keeps the test about the property in question — that the route
// taken to the file does not change what the program does.
test("the CLI behaves identically whether invoked directly or through a symlink", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pke-entry-point-"));
  try {
    const link = path.join(directory, "pke");
    await symlink(CLI_PATH, link);

    const direct = await invoke(CLI_PATH, ["--help"]);
    const linked = await invoke(link, ["--help"]);

    // Guards the test itself: if the direct invocation ever stopped producing
    // output, both sides would be empty and equal, and the assertions below
    // would hold while proving nothing.
    assert.ok(
      direct.stdout.length + direct.stderr.length > 0,
      "direct invocation produced no output, so the comparison would be vacuous",
    );
    assert.notEqual(direct.code, 0, "expected --help to be reported as a usage error");

    assert.equal(linked.code, direct.code);
    assert.equal(linked.stdout, direct.stdout);
    assert.equal(linked.stderr, direct.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A symlink to a symlink, which is what a package manager plus a version
// manager can produce between PATH and the installed file.
test("the CLI entry point survives a chain of symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pke-entry-point-chain-"));
  try {
    const inner = path.join(directory, "pke-inner");
    const outer = path.join(directory, "pke");
    await symlink(CLI_PATH, inner);
    await symlink(inner, outer);

    const direct = await invoke(CLI_PATH, ["--help"]);
    const chained = await invoke(outer, ["--help"]);

    assert.equal(chained.code, direct.code);
    assert.equal(chained.stderr, direct.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The guard's other half. It exists so that importing the module for its
// exports does not execute a command, and a fix that made the guard more
// permissive could break that silently: the suite imports dist/cli.js
// throughout, so an entry point firing on import would run a CLI command on
// every import.
test("importing the CLI module does not execute a command", async () => {
  const probe = [
    "const before = process.exitCode;",
    `await import(${JSON.stringify(CLI_PATH)});`,
    "console.log(JSON.stringify({ exitCode: process.exitCode ?? null, before: before ?? null }));",
  ].join("\n");

  const { stdout } = await execFileAsync("node", ["--input-type=module", "--eval", probe], {
    env: { ...process.env },
  });
  const parsed = JSON.parse(stdout.trim()) as { exitCode: number | null };
  assert.equal(parsed.exitCode, null, "importing the module set an exit code, so it ran a command");
});
