# Project Knowledge Engine — Technology and Deployment Specification

**Version:** 2.3
**Supersedes:** 05 v2.2; originally supersedes 05 v1.0, which recommended PHP and Laravel
**Status:** Resolves TD-5, TD-6a, TD-16 to TD-19
**Derived from:** 04 Master Technical Specification v1.3
**Scope:** Technology selection, runtime topology, and deployment model for V1 only
**Derivation authority:** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it.
**Vocabulary authority (domain concepts):** 02 Domain Specification. Entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants are defined there. The Vision is prose; where Vision prose contradicts the Domain Spec on a domain concept, the Vision is the defect.

---

## 0. Why This Document Was Rewritten

Version 1.0 recommended PHP and Laravel on grounds of operational familiarity with the curator's other projects. That rationale was wrong in kind, not merely in degree.

**The Knowledge Engine must be independent of every project it stores knowledge about.** It will hold knowledge about a Laravel project, a Next.js project, and a Python project. Selecting its runtime to match one of them makes the tool a satellite of that project rather than infrastructure that outlives all of them. The Domain Specification and the PRD were already stack-independent; only this document leaked.

Version 1.0 also rejected `stdio` transport for a reason that does not survive examination. The claim was that per-session processes leave no single place to measure tier escalation and pack coverage. All instrumentation writes to PostgreSQL. Measurement is shared across processes regardless of transport. Withdrawn.

---

## 1. Summary of Choices

| Concern | Choice | Confidence |
|---|---|---|
| Database | PostgreSQL 17 with `ltree`, `pg_trgm`, `unaccent`, `pgcrypto` | High |
| Vector extension | `pgvector`-capable image, extension **not created** | High |
| Language | TypeScript on Node 22 LTS | Moderate. Python is a near-equal alternative |
| MCP | `@modelcontextprotocol/sdk` (TypeScript) | High |
| Model vendor SDK | **None. Ever.** | High |
| Transport | `stdio` default, streamable HTTP optional, one server object | High |
| Database access | Hand-written SQL migrations; query builder only, no schema-owning ORM | High |
| Curator interface | Local CLI binary | High |
| Blob storage | Local content-addressed directory | High |
| Search | PostgreSQL full-text (`tsvector` + GIN) | High |
| Queue, cache, Redis | **None** | High |
| Containerisation | **Database containerised. Engine not.** | High |
| Distribution | `npx` from a package registry, or a local path | High |

The most important property of this stack is that it has three moving parts: a Node process, a Postgres container, and cron. A tool maintained by one person in the gaps between other projects dies from operational surface area, not from missing features.

---

## 2. Language: TypeScript

### 2.1 The decision

TypeScript on Node 22 LTS, one language across the domain layer, the MCP access layer, and the curator CLI.

Python would produce an equally correct system. This is a preference-weighted decision, not a correctness one, and the document should say so plainly rather than manufacture certainty.

### 2.2 The argument that actually decides it

**The engine never calls a model** (Master Tech Spec 18.3, TD-17).

This is not incidental. It is enforced by three separate requirements already in the specifications:

- Pack assembly is pure selection with no generation at build time (PRD-CTX-004).
- Artifact summaries are authored at approval and stored, never regenerated (PRD-ART-004).
- Candidate extraction happens in the **calling agent**. `discussion.resolve` receives a structured proposal the agent has already produced with its own model, validates it against schema, invariants, and relation legality, and persists it to triage.

The usual reason to choose Python for anything adjacent to LLMs is ecosystem access: model SDKs, embedding libraries, evaluation harnesses, chunking tooling. None of that is present here and none of it may be added, because adding it would break vendor neutrality.

What remains is a typed, invariant-heavy, SQL-heavy graph server consumed over a protocol. That has more in common with an authorization service than with a retrieval pipeline. TypeScript is at least as good a fit as Python for that shape of problem, and better on distribution.

### 2.3 Supporting reasons

**Distribution.** `npx @scope/pke-mcp` is one line in a client configuration with no installation step. `uvx` is equally supported by major clients, so this is a modest edge rather than a decisive one, but Node's ubiquity means fewer environments where it is a problem.

**One language end to end.** The pack assembler, the MCP handlers, and the CLI share types. The `RenderedObject` returned over MCP is the same type the assembler produced, checked by the compiler rather than by a test.

**Type-level modelling of the domain.** Discriminated unions over the ten entity types, with `never`-based exhaustiveness checks, catch a missing case in a `switch` at compile time. This matters in a design with ten state machines and eighty-eight legal relation triples.

### 2.4 Corrections to the earlier comparison

Version 1.0 and the surrounding discussion overstated parts of the TypeScript case. For the record, since this is a one-way decision:

| Earlier claim | Correction |
|---|---|
| TS discriminated unions uniquely provide exhaustiveness checking | mypy does this correctly with `Literal`, `Enum`, and `assert_never`. Close to a wash |
| Zod is a clear advantage for runtime validation | Pydantic is equally capable and arguably more mature. A wash, or a slight point to Python |
| `npx` distribution is decisive | `uvx` is equally supported. A modest edge, not decisive |
| (Not previously stated) | **Alembic is better than any Node migration tool** for the trigger-heavy, `ltree`-heavy, partial-index-heavy migrations this schema needs. A real point for Python, mitigated by TD-18 requiring hand-written SQL regardless |

### 2.5 When Python would have been correct

If the engine were to run local embedding models, iterate on chunking strategies, or train a reranker. It does none of these, and TD-17 forbids the first from ever moving in-process.

If that changes, the embedding sidecar (Section 6) is a separate process and may be written in Python without touching the engine. This is the specific reason the sidecar is architecturally separate rather than a module.

### 2.6 Dependency policy

The dependency manifest is a design artefact and is reviewed as one.

**Permitted:** the MCP SDK, a Postgres driver, a query builder, a runtime schema validator, a CLI framework, a test runner.

**Forbidden:**

- Any model vendor SDK, including Anthropic's. Note that `@modelcontextprotocol/sdk` is the protocol SDK and is unrelated to any vendor's API client. If a model vendor SDK appears in `package.json`, TD-17 has been violated.
- Any schema-owning ORM (TD-18). Named explicitly: **Prisma is excluded.** It will fight triggers, `ltree`, partial indexes, generated `tsvector` columns, per-type CHECK constraints on JSONB, and recursive CTEs at every step. Drizzle, Kysely, or the `pg` driver with hand-written SQL are all acceptable, because they treat SQL as the source of truth rather than as generated output.
- Anything requiring a network call during pack assembly (boundary rules B-5, B-6).

---

## 3. Database

### 3.1 PostgreSQL 17

Already selected in the Domain Specification. The reasons are specific rather than general preference, because the design leans on four features with no clean equivalent elsewhere.

**Partial indexes.** Nearly every hot query filters `WHERE valid_to_version IS NULL`. In a system that never deletes and grows by supersession, the active set becomes a shrinking fraction of the table. Without partial indexes, every index carries the full history and the always-inject path degrades as the graph accumulates. The label registry and its aliases are version-windowed the same way (Master Tech Spec 3.4.1), so this applies to four tables, not one. This alone decides it.

**Array columns with GIN.** `feature_label_ids text[]` with a GIN index makes feature filtering one indexed predicate. Without array indexing, labels need a join table, turning pack assembly from one scan into a join per filter.

**`ltree` for scope paths.** Scope chain resolution becomes `WHERE path @> target.path` with a GiST index: one indexed query, no recursion. The recursive CTE in Master Tech Spec 3.2 remains the normative definition and the test oracle.

**JSONB with `jsonb_path_ops`.** Entity-specific attributes are indexed and queryable without ten tables. Combined with CHECK constraints on required keys, this gives most of the safety of columns without the migration cost.

Beyond those: generated `tsvector` columns for keyword search, `pg_trgm` for structural duplicate detection (14.5), expressive triggers for the append-only invariants (INV-7, INV-8, INV-12), and recursive CTEs for change-impact propagation.

### 3.2 On MySQL and SQLite

Neither is under consideration now that the engine is stack-independent, but the reasoning is recorded so it is not relitigated.

**MySQL** has no partial indexes at all, no array types, and no `ltree`. The port would require simulating the active set with a trigger-maintained side table, a join table for features, and recursive CTEs on every scope read. Doable, materially worse.

**SQLite** is a genuine near-fit: single-user, local, append-only, near-zero write contention, and it would remove the database from the deployment entirely. Rejected for three reasons: no array or JSONB indexing, no `ltree`, and it closes the pgvector path at exactly the point the graph is large enough to want it.

### 3.3 Extensions

| Extension | Purpose | Created in V1 |
|---|---|---|
| `ltree` | Scope paths | Yes |
| `pg_trgm` | Duplicate detection (14.5) | Yes |
| `unaccent` | Keyword and glossary term normalisation | Yes |
| `pgcrypto` | Content hashing where done in-database | Yes |
| `vector` | Tier 4 retrieval | **No.** Available in the image, not created |

A `pgvector`-capable image is used from day one with the extension uncreated. This costs nothing and means enabling tier 4 later is one migration rather than an image swap and a data migration (TD-19).

### 3.4 Migrations

Hand-written SQL files, forward-only, numbered, under version control (TD-18). A thin runner applies them in order and records applied versions.

This is not austerity. The schema is roughly 40 percent constructs that schema-generating tools do not model: triggers enforcing INV-7 and INV-8, the legality trigger, the acyclicity check for INV-12, partial unique indexes for INV-6, generated `tsvector` columns, `ltree` maintenance triggers, and per-type CHECK constraints on JSONB keys.

Every invariant that protects trust is enforced in the database, not only in the application (Master Tech Spec 19.3). Application-only enforcement is enforcement until the first bug, and the first bug in this system is a silent trust failure.

---

## 4. Transport and Distribution

### 4.1 Both transports, one server object

The MCP SDK supports attaching multiple transports to a single server. Both expose the identical tool set and identical authority.

| Transport | Default | Lifecycle | Use |
|---|---|---|---|
| `stdio` | Yes | One process per client session | Local clients: Claude Code, Codex, Cursor |
| Streamable HTTP | No | One long-running process | Shared local server, multiple concurrent clients, easier log tailing |

**`stdio` is the default** because it is the single-line, zero-install pattern every major client supports, and client neutrality is a stated product goal that is otherwise untested in V1.

The v1.0 objection to `stdio` was measurement. It does not hold: instrumentation writes to PostgreSQL (Master Tech Spec 23), so tier escalation and pack coverage aggregate correctly across any number of processes.

### 4.2 Concurrency

Multiple `stdio` processes share one database. The design already handles this: the curation transaction is the single write primitive, graph version is allocated inside it, and `lock_version` provides optimistic concurrency. Read paths are version-windowed and unaffected.

Note that agent-facing tools cannot write durable knowledge at all, so concurrent MCP processes contend only on Candidate inserts and raw Discussion writes, neither of which conflicts.

### 4.3 Distribution

```jsonc
// client MCP configuration
{
  "pke": {
    "command": "npx",
    "args": ["-y", "@scope/pke-mcp"],
    "env": { "PKE_DATABASE_URL": "postgres://pke:pke_local@127.0.0.1:5433/pke" }
  }
}
```

During development the same entry points at a local path instead. Publishing to a registry is optional in V1 and becomes worthwhile only if a second machine appears.

### 4.4 Two surfaces, one codebase

| Surface | Transport | Authority |
|---|---|---|
| Agent | MCP: `context.build`, `graph.expand`, `discussion.resolve`, `artifact.get` | Read, plus propose Candidates |
| Curator | CLI binary | Full |

The separation is structural, not a permission check. **The MCP handler modules do not import the write use cases**, so there is no code path by which a prompt-injected agent reaches approval, supersession, or verification. In a system with no authentication (Master Tech Spec 24), this import boundary is the security model, and a lint rule should enforce it.

---

## 5. Containerisation

### 5.1 Recommendation: database in Docker, engine on the host

```
┌──────────────────────── host machine ────────────────────────┐
│                                                               │
│   Node 22                                                     │
│   ├── npx @scope/pke-mcp      stdio, spawned per client       │
│   ├── pke <command>           curator CLI                     │
│   └── pke maintenance         via cron, daily                 │
│                                                               │
│   ./storage/blobs/            content-addressed transcripts   │
│                                                               │
│              │ TCP 5433                                       │
│   ┌──────────▼───────────────────────────────┐                │
│   │  Docker: pgvector/pgvector:pg17           │                │
│   │  volume: pgdata                           │                │
│   └───────────────────────────────────────────┘               │
└───────────────────────────────────────────────────────────────┘
```

### 5.2 Why the database is containerised

The version is pinned, extensions arrive preinstalled with the `pgvector` image, the data lives in a named volume (`pgdata`) that `docker compose down -v` destroys, and rebuilding during backfill iteration is one command. Postgres exposes one port and holds no state you need to reach into. There is no meaningful downside. A bind mount was rejected: `down -v` does not remove bind-mount directories, so `make fresh` would silently keep stale schema.

### 5.3 Why the engine is not

The `stdio` default makes this stronger than it was in v1.0. A containerised `stdio` server means the client must spawn a process inside a container, which every client makes awkward and some make impossible.

Beyond that:

**Backfill breaks.** Master Tech Spec Section 22 imports declarative files you author in a normal editor in a normal directory. Containerised, every import path needs a bind mount, and every path error becomes a mount error rather than a typo.

**The curator loop slows.** Triage runs many times a day. `pke triage` versus `docker compose exec engine pke triage` is enough friction, repeated enough times, to matter. The failure mode this product exists to prevent is the curator quietly stopping. Do not put a container between the curator and triage.

**Precedent.** Graphiti is parked in this stack over upstream Docker image problems. That is direct evidence that container friction is an abandonment risk for this tool in this context, not a hypothetical one.

### 5.4 Keep it containerisable anyway

Costs nothing now, makes a later server deployment a packaging exercise:

- All configuration from environment variables. No hardcoded paths, no assumptions about a home directory.
- No local state other than the database and the blob directory, and the blob path is configurable.
- The HTTP transport binds to a configurable host and port.

### 5.5 When to containerise the engine

Any one of these flips the decision: a second person needs access, it moves to a server, or a second consuming client appears on a different machine. None applies to V1.

### 5.6 `compose.yaml`

```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    container_name: pke-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: pke
      POSTGRES_USER: pke
      POSTGRES_PASSWORD: pke_local
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pke -d pke"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

Port 5433 deliberately, so this never collides with another local Postgres. Bound to `127.0.0.1` explicitly: the system has no authentication and must not be reachable off the machine. Named volume so `docker compose down -v` (and therefore `make fresh`) actually wipes the database.

---

## 6. Supporting Choices

| Concern | Choice | Reasoning |
|---|---|---|
| Blob storage | Local directory, content-addressed by SHA-256 | Discussion transcripts over 32 KB (TD-3). Object storage adds a credential for no benefit at this scale |
| Search | Postgres FTS, generated `tsvector`, GIN | Tier 3 only. A search daemon for a few thousand short objects is not justified |
| Embeddings | **Out-of-process sidecar, not in V1** | TD-17 and TD-19. Reads rows where `embedding IS NULL`, computes, writes back. May be written in any language, including Python. Architecturally separate precisely so the engine's language never constrains it |
| Queue | None | Nothing is asynchronous. Change-impact propagation runs inside the curation transaction by design: a curator told about impact ten seconds later has already moved on |
| Cache | None | Pack assembly is fast and must stay reproducible. A cache keyed on anything less than the full recipe hash is a correctness bug waiting to happen |
| Redis | None | Follows from the above. One fewer daemon |
| Scheduler | System cron calling a maintenance command | Daily Observation expiry (5.3), Candidate expiry (5.10), staleness view refresh |
| Backups | Nightly `pg_dump` plus rsync of the blob directory | Append-only means a daily snapshot loses at most a day, and the graph version log makes it obvious what was lost |
| Testing | Node test runner or Vitest, plus a property-testing library for the determinism suites | Master Tech Spec Section 21 needs thousands of iterations, which is why the domain layer must be pure and database-free |

---

## 7. Repository Layout

```
pke/
├── compose.yaml
├── package.json
├── Makefile
├── migrations/                  hand-written SQL, forward-only
│   ├── 000_graph_versions.sql   curation transaction clock (MTS 8.1)
│   ├── 001_scopes.sql
│   ├── 002_feature_labels.sql   registry + aliases, version-windowed
│   ├── 003_knowledge_objects.sql
│   ├── 004_relations_and_legality.sql
│   ├── 005_triggers_invariants.sql
│   ├── 016_graph_identity_prefixes.sql
│   └── ...
├── src/
│   ├── domain/                  pure. no I/O, no SDK, no db types
│   │   ├── entity/
│   │   ├── scope/               resolution
│   │   ├── label/               registry resolution, aliases, redirects
│   │   ├── relation/            vocabulary + legality matrix
│   │   ├── invariant/
│   │   ├── state-machine/
│   │   └── pack/                assembler, ordering, truncation, diff
│   ├── application/             use cases, curation transaction
│   ├── infrastructure/
│   │   ├── persistence/         query builder, repositories
│   │   └── blob/
│   ├── mcp/                     tool handlers. MUST NOT import write use cases
│   └── cli/                     curator commands
├── storage/blobs/
├── backfill/                    declarative import files (MIRA)
└── tests/
```

`src/domain/` imports nothing from `src/infrastructure/`, `src/mcp/`, or the SDK. `src/mcp/` imports no write use case. Both rules are enforced by a dependency lint rule, not by discipline, because both are load-bearing for properties the product sells.

---

## 8. Operation

```makefile
up:        docker compose up -d
down:      docker compose down
fresh:     docker compose down -v && docker compose up -d --wait && npm run migrate
migrate:   node dist/cli.js migrate
triage:    node dist/cli.js triage
backfill:  node dist/cli.js backfill --dry-run backfill/mira
serve:     node dist/cli.js serve --http --host 127.0.0.1 --port 8377
test:      npm test
```

`npm test` provisions a uniquely named throwaway PostgreSQL database from
`PKE_DATABASE_URL`, applies all migrations, and runs the suite there. It drops
that database after the run, so test curation transactions and sequence gaps
cannot enter the real graph history. The configured PostgreSQL role therefore
needs `CREATEDB`; `PKE_DATABASE_URL` must be a PostgreSQL URL.

Cron, one line:

```
0 3 * * * cd /path/to/pke && node dist/cli.js maintenance >> logs/maintenance.log 2>&1
```

No process manager is needed for the default configuration, because `stdio` servers are spawned and reaped by the client. A process manager is needed only if the optional HTTP transport is run persistently, in which case `launchd` or a systemd user unit is sufficient.

---

## 9. What Is Deliberately Absent

| Absent | Why |
|---|---|
| Any model vendor SDK | TD-17. Vendor neutrality is structural, not policy |
| Prisma or any schema-owning ORM | TD-18. It would fight every database-level invariant |
| Redis, queues, workers | Nothing is asynchronous |
| A graph database | Traversals are two to six hops; recursive CTEs suffice |
| A vector database | Tier 4 is out of V1; the extension is one migration away |
| A search daemon | Corpus size does not warrant it |
| Authentication | Single user, localhost only |
| Containerised engine | Section 5.3 |
| CI/CD | One developer, one machine. Tests before commit |
| Observability stack | Structured logs to file. Metrics are SQL queries (Master Tech Spec 23) |

Ten absences. Each one is a daemon, a credential, or a config file that would otherwise need maintaining forever by one person with several other projects.

---

## 10. Decisions Resolved and Still Open

**Resolved by this document:**

- **TD-5** PostgreSQL 17, `pgvector`-capable image with the extension uncreated, no graph database
- **TD-6a** TypeScript on Node 22, MCP TypeScript SDK, framework-free domain layer. TD-6 (PHP/Laravel) superseded
- **TD-16** Both transports on one server object, `stdio` default
- **TD-17** The engine never calls a model; no vendor SDK in the manifest
- **TD-18** Hand-written SQL migrations, no schema-owning ORM, Prisma excluded by name
- **TD-19** Vector column reserved, embeddings generated out of process
- Containerisation: database only

**Closed since v2.0, by curator decision:**

- **TC-1** determinism. Pack contents determined by graph version; staleness labels may vary by build time. Both recorded on the pack
- **TC-3** acyclicity. Accepted as INV-12 in the Domain Spec
- **OQ-P4** session definition. One agent or client work session, client-agnostic
- **OQ-P6** verification cascade. No cascade
- **DG-1 / DG-4** Risk and Assumption. Deferred as candidate concepts pending backfill evidence

- **TC-2** graph version granularity. One version per committed curation transaction, verification and Candidate operations excepted. Now normative in Domain Spec 7A
- **TC-7 / OQ-P1** feature labels. Controlled Project-scoped canonical registry with aliases, a candidate workflow at the proposal boundary, and merge by versioned redirect. Adds `feature_labels` and `feature_label_aliases`, both version-windowed

**Still open, unaffected by technology selection:**

| Item | Blocks |
|---|---|
| **OQ-P2** MIRA backfill corpus | **The backfill.** Last remaining item before work can start |
| **OQ-P8** promote Risk or Assumption? | Decided by backfill evidence, not now |
| **OQ-P9** Artifact staleness threshold | A config value after baseline |
