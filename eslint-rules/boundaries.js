import path from "node:path";

const WRITE_BASENAMES = new Set([
  "accept-candidate",
  "accept_candidate",
  "approve",
  "supersede",
  "supersede-object",
  "supersede_object",
  "verify",
  "verify-object",
  "verify_object",
  "triage",
  "curation-transaction",
  "curation_transaction",
]);

function specifierOf(node) {
  if (node.type === "ImportExpression") {
    return node.source?.type === "Literal" ? node.source.value : null;
  }
  return node.source?.value ?? null;
}

function resolveImport(filename, spec) {
  if (typeof spec !== "string") return null;
  if (!(spec.startsWith(".") || spec.startsWith("/"))) return { kind: "package", spec };
  return { kind: "relative", spec, resolved: path.resolve(path.dirname(filename), spec) };
}

function matchesLayer(resolved, layer) {
  const norm = resolved.replaceAll("\\", "/");
  const needle = `/src/${layer}`;
  return norm.includes(`${needle}/`) || norm.includes(`${needle}.`) || norm.endsWith(needle);
}

function isWriteUseCase(resolved) {
  const norm = resolved.replaceAll("\\", "/");
  // Durable writes live under one directory so adding a new use case cannot
  // silently bypass this boundary by choosing a new filename.
  if (norm.includes("/src/application/write/") || norm.endsWith("/src/application/write")) {
    return true;
  }
  const base = path.basename(resolved).replace(/\.(ts|js|mts|cts|tsx|jsx)$/u, "");
  return norm.includes("/src/application/") && WRITE_BASENAMES.has(base);
}

const DOMAIN_ALLOWED_PACKAGES = new Set([
  "node:assert",
  "node:assert/strict",
  "node:crypto",
  "node:util",
]);

const DOMAIN_BANNED_IO = new Set(["fs", "http", "https", "http2", "net", "pg"]);

function packageRoot(spec) {
  const withoutNode = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
  return withoutNode.split("/")[0] ?? withoutNode;
}

function checkDomainImport(context, node) {
  const spec = specifierOf(node);
  const resolved = resolveImport(context.filename, spec);
  if (!resolved) return;
  if (resolved.kind === "package") {
    const root = packageRoot(resolved.spec);
    if (DOMAIN_BANNED_IO.has(root)) {
      context.report({
        node: node.source ?? node,
        messageId: "forbiddenIo",
        data: { name: resolved.spec },
      });
      return;
    }
    if (!DOMAIN_ALLOWED_PACKAGES.has(resolved.spec)) {
      context.report({
        node: node.source ?? node,
        messageId: "forbiddenPackage",
        data: { name: resolved.spec },
      });
    }
    return;
  }
  for (const layer of ["infrastructure", "mcp", "cli"]) {
    if (matchesLayer(resolved.resolved, layer)) {
      context.report({
        node: node.source ?? node,
        messageId: "forbiddenLayer",
        data: { layer },
      });
    }
  }
}

function checkMcpImport(context, node) {
  const spec = specifierOf(node);
  const resolved = resolveImport(context.filename, spec);
  if (!resolved || resolved.kind !== "relative") return;
  if (isWriteUseCase(resolved.resolved)) {
    context.report({
      node: node.source ?? node,
      messageId: "forbiddenWrite",
      data: { spec },
    });
  }
}

function importedNames(node) {
  return (node.specifiers ?? [])
    .map((specifier) => specifier.imported?.name)
    .filter((name) => typeof name === "string");
}

function moduleStem(filename) {
  return filename.replace(/\.(ts|js|mts|cts|tsx|jsx)$/u, "").replaceAll("\\", "/");
}

function checkBackfillBoundary(context, node) {
  const spec = specifierOf(node);
  const resolved = resolveImport(context.filename, spec);
  if (!resolved || resolved.kind !== "relative") return;
  const source = moduleStem(resolved.resolved);
  const isDedicatedModule = source.endsWith("/src/application/write/backfill");
  const isTransactionModule = source.endsWith("/src/application/write/transaction");
  const isNamespaceImport = (node.specifiers ?? []).some(
    (specifier) => specifier.type === "ImportNamespaceSpecifier",
  );
  const isCapabilityExport =
    isTransactionModule &&
    (importedNames(node).includes("backfillCurationTransaction") ||
      node.type === "ExportAllDeclaration" ||
      isNamespaceImport);
  if (!isDedicatedModule && !isCapabilityExport) return;

  const importer = moduleStem(context.filename);
  const allowed =
    importer.includes("/src/application/backfill/") ||
    importer.endsWith("/src/application/write/backfill");
  if (!allowed) {
    context.report({
      node: node.source ?? node,
      messageId: "forbiddenBackfillBoundary",
      data: { spec },
    });
  }
}

const importSelectors = {
  ImportDeclaration: "ImportDeclaration",
  ImportExpression: "ImportExpression",
  ExportAllDeclaration: "ExportAllDeclaration",
  ExportNamedDeclaration: "ExportNamedDeclaration",
};

export const domainBoundary = {
  meta: {
    type: "problem",
    docs: {
      description:
        "src/domain/ imports nothing from infrastructure, mcp, cli, or any SDK (05 §7, TD-17).",
    },
    messages: {
      forbiddenLayer:
        "src/domain/ must not import {{layer}} (05 §7: domain is pure; no I/O, no SDK, no db types).",
      forbiddenIo: "src/domain/ must not import '{{name}}' (banned I/O: pg, fs, net, http).",
      forbiddenPackage:
        "src/domain/ must not import '{{name}}'. Permitted node builtins: node:crypto, node:assert, node:util (05 §7, TD-17).",
    },
    schema: [],
  },
  create(context) {
    const visitor = {};
    for (const key of Object.keys(importSelectors)) {
      visitor[key] = (node) => {
        if (key.startsWith("Export") && !node.source) return;
        checkDomainImport(context, node);
      };
    }
    return visitor;
  },
};

export const mcpNoWrite = {
  meta: {
    type: "problem",
    docs: {
      description:
        "src/mcp/ must not import durable-write use cases (05 §4.4, §7; Master Tech Spec 18.1).",
    },
    messages: {
      forbiddenWrite:
        "src/mcp/ must not import write use case '{{spec}}' (05 §4.4: approval, supersession, verification, and other durable writes are curator-only).",
    },
    schema: [],
  },
  create(context) {
    const visitor = {};
    for (const key of Object.keys(importSelectors)) {
      visitor[key] = (node) => {
        if (key.startsWith("Export") && !node.source) return;
        checkMcpImport(context, node);
      };
    }
    return visitor;
  },
};

export const backfillBoundary = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The backfill transaction capability may only be imported by the backfill importer.",
    },
    messages: {
      forbiddenBackfillBoundary:
        "Backfill transaction capability '{{spec}}' is importer-only (A-BF-1).",
    },
    schema: [],
  },
  create(context) {
    const visitor = {};
    for (const key of Object.keys(importSelectors)) {
      visitor[key] = (node) => {
        if (key.startsWith("Export") && !node.source) return;
        checkBackfillBoundary(context, node);
      };
    }
    return visitor;
  },
};
