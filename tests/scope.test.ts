import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveChain,
  resolveChainByPath,
  type Scope,
  type ScopeKind,
} from "../dist/domain/index.js";

function add(
  scopes: Scope[],
  id: string,
  kind: ScopeKind,
  parent: Scope | null,
  name: string,
): Scope {
  const depth = parent === null ? 0 : parent.depth + 1;
  const label = id.replace(/[^A-Za-z0-9_]/g, "_");
  const path = parent === null ? label : `${parent.path}.${label}`;
  const scope: Scope = {
    id,
    kind,
    parentId: parent?.id ?? null,
    name,
    path,
    depth,
  };
  scopes.push(scope);
  return scope;
}

function generateTree(): Scope[] {
  const scopes: Scope[] = [];
  const global = add(scopes, "global", "global", null, "Global");
  for (const projectName of ["beacon", "other"]) {
    const project = add(scopes, `project_${projectName}`, "project", global, projectName);
    for (const streamName of ["hiring", "platform"]) {
      const stream = add(
        scopes,
        `ws_${projectName}_${streamName}`,
        "workstream",
        project,
        streamName,
      );
      for (const phaseName of ["p1", "p2"]) {
        add(scopes, `phase_${projectName}_${streamName}_${phaseName}`, "phase", stream, phaseName);
      }
    }
  }
  return scopes;
}

test("resolveChain and resolveChainByPath agree on every scope in a four-level tree", () => {
  const scopes = generateTree();
  assert.equal(scopes.length, 15);
  assert.ok(scopes.some((scope) => scope.kind === "phase" && scope.depth === 3));
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  for (const scope of scopes) {
    const walked = resolveChain(scope.id, byId).map((row) => row.id);
    const byPath = resolveChainByPath(scope, scopes).map((row) => row.id);
    assert.deepEqual(byPath, walked, scope.id);
    assert.equal(walked[walked.length - 1], "global");
    assert.equal(walked.length, scope.depth + 1);
  }
});
