# Engram

**Beta.** A knowledge engine for long-lived software projects, accessible to any MCP client.

Engram stores why your project is the way it is: decisions and their reasoning, constraints that still apply, approaches already tried and rejected, unresolved questions, and project vocabulary. It assembles that into deterministic Context Packs that an AI assistant reads before it starts work.

It is not a chat archive, a notes app, or an AI memory system. See [Why this is not AI memory](#why-this-is-not-ai-memory).

---

## The problem

In a project that runs for months, implementation survives and reasoning does not. The code is there. The pull requests are there. What disappears is why a decision was made and what was rejected in making it, which requirement caused it and whether that requirement still holds, what was already tried and failed, and what remains unresolved.

The symptoms are specific: the same discussion happens twice, a previously rejected approach gets proposed again, an architectural choice gets undone by someone who did not know why it existed, and an AI assistant is re-briefed on the same background every session.

---

## What it does

```
You discuss something with an AI assistant
        ↓
Assistant proposes a structured Decision via discussion.resolve
        ↓
You accept, edit, or reject it in triage
        ↓
It is durable knowledge, scoped and related
        ↓
Any MCP client requests a Context Pack and starts work informed
```

**Real example.** Asked "why doesn't this project use email as the contact identity?", an assistant with Engram answered from the graph: email was tried in production, caused identity collisions and a 3.23M-record re-import, and was replaced by a composite key. It cited the decision, the failed attempt, and the constraint that still forbids it.

The codebase could not have said that. It only shows the composite key that came after.

---

## Quick start

**Requirements:** Node 22+, Docker (for Postgres), an MCP client.

```bash
git clone https://github.com/YOURNAME/engram.git
cd engram
npm install
npm run build

docker compose up -d          # Postgres 17 on 127.0.0.1:5433
node dist/cli.js migrate
```

Create a project:

```bash
node dist/cli.js scope add --kind project --parent global \
  --id project_myapp --name "My App"
node dist/cli.js scope add --kind workstream --parent project_myapp \
  --id ws_myapp_api --name "API"
```

Point your MCP client at it. For Claude Code or Cursor:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/absolute/path/to/engram/dist/cli.js", "mcp"],
      "env": {
        "PKE_DATABASE_URL": "postgres://pke:pke_local@127.0.0.1:5433/pke"
      }
    }
  }
}
```

Restart the client. Four tools appear: `context.build`, `graph.expand`, `discussion.resolve`, `artifact.get`.

Optional, so `pke` works as a command:

```bash
alias pke='node /absolute/path/to/engram/dist/cli.js'
```

---

## Daily use

**Capture.** After settling something with your assistant, ask it to record the decision. It calls `discussion.resolve` with a structured proposal. Nothing enters the graph yet.

**Triage.** Review what was proposed:

```bash
pke triage                      # pending candidates, stale objects, flagged decisions
pke triage accept CND-0001
pke triage edit CND-0002        # opens $EDITOR, accepted as human-authored
pke triage reject CND-0003
```

**Retrieval** is automatic. Assistants call `context.build` when they need project context.

**Maintenance**, daily via cron:

```
0 3 * * * cd /path/to/engram && node dist/cli.js maintenance >> logs/maintenance.log 2>&1
```

---

## Read this before deploying

**Engram is single-user and has no authentication.** It binds to localhost. The security model is that nothing outside your machine can reach it.

If you put this on a shared server, anyone who can reach the port can read and write your knowledge graph. Multi-user support is not a missing feature — the whole design assumes one curator, and adding auth without reworking provenance and approval would give you a false sense of safety.

**Two boundaries that matter if you modify the code:**

- `src/mcp/` imports no write use case. With no auth, that import boundary is what stops a prompt-injected agent from writing to the graph. A lint rule enforces it. Do not relax it.
- `src/domain/` imports no I/O, no SDK, no database types. Pack assembly must stay pure or the determinism guarantee breaks.

---

## Design decisions worth knowing

**Append-only.** Approved knowledge is never edited or deleted. Corrections happen by supersession, so the history of being wrong is preserved. Enforced by database triggers, not just application code.

**Nothing enters automatically.** AI proposes, a human accepts. Automatic extraction produces confident noise, and noisy knowledge is worse than none because you stop trusting the graph and then stop writing to it.

**Retrieval prefers certainty over similarity.** Exact relationships, then metadata, then keyword. No embeddings. Whether a decision is still binding is a question of status and supersession, not cosine distance.

**Context Packs are deterministic.** Selection and ordering are a pure function of the request and the graph version. No summarisation or generation at build time. A pack can be rebuilt identically months later, and two packs can be diffed to show what changed.

**The engine never calls a model.** No vendor SDK, no API key, no outbound network requirement. Extraction happens in the calling assistant; Engram validates and files. Your knowledge outlives whichever model you use.

**Store why, reference what.** Git owns commits, your tracker owns tasks, your docs own documents. Engram stores the reasoning connecting them, plus pointers. It never mirrors.

---

## The model

Knowledge lives in a fixed scope tree: **Global → Project → Workstream → Phase**. Features are cross-cutting labels, not a scope level.

| Class | Types | Behaviour |
|---|---|---|
| **Raw** | Discussion, Observation | Evidence. No approval needed. Retention limits. Never injected as body text |
| **Reviewed** | Requirement, Decision, Open Question, Hypothesis, Artifact | Approved assertions. Append-only |
| **Operational** | Constraint, Glossary Entry | Constraints inject into every pack in scope. Glossary entries match on term |

Objects relate through eight typed verbs: `derives_from`, `supersedes`, `references`, `blocks`, `requires`, `invalidates`, `explains`, `implemented_by`. The vocabulary is closed — free-text relation names drift into synonyms within months and make traversal unreliable.

Two distinctions that matter in practice:

**Hypothesis vs rejected alternative.** A Hypothesis was actually built, run, or tested, and failed. An idea killed in discussion lives inside the Decision that rejected it. Without this, assistants get told not to try things nobody ever tried.

**Requirement change impact.** Supersede a Requirement and every Decision deriving from it is flagged for review, transitively. They stay active — the system guarantees none is silently resting on a dead premise, and does not pretend to know which are still right.

---

## Why this is not AI memory

Memory systems answer *"what should this assistant remember about me?"* They extract facts, embed them, retrieve by similarity. That is a reasonable answer to a personalisation problem and the wrong shape for this one.

- **Authority is not similarity.** Whether a decision still binds is a question of status and supersession.
- **Conversation is the wrong unit.** Six weeks later nobody needs the exchange, only the conclusion.
- **Knowledge outlives the assistant.** Tie the value to one model's memory format and it evaporates when you switch tools.

The closest honest prior art is Architecture Decision Records, extended with a scope model, a typed graph, requirement traceability, and a programmatic access surface.

---

## Importing existing history

If your project predates Engram, `backfill/` imports declarative JSON. See `docs/22-backfill-format.md`.

Two things you will hit, both by design:

**Origins are often unrecoverable.** A Decision needs a traceable origin. Historical decisions frequently have none. Backfill mode lets you record `origin: unrecoverable`, which renders visibly in every pack — an honest "this is binding and nobody wrote down why" rather than a fabricated source.

**Do not force items into near-fit types.** If something has no home, record it as a gap and leave it out. Forcing produces knowledge that is quietly wrong, which is worse than a visible gap.

---

## CLI

```
pke migrate                          apply migrations
pke scope add|list                   manage the scope tree
pke triage [accept|edit|merge|reject]
pke verify <id>                      confirm still valid; surfaces derived constraints
pke supersede <id>                   replace with a successor
pke retract <id>                     mark as never valid knowledge
pke impact <requirement-id>          decisions deriving from a requirement
pke pack diff <a> <b>                what changed between two packs
pke pack reproduce <id>              rebuild a pack at its recorded version
pke backfill [--dry-run] <dir>       import declarative JSON
pke maintenance                      expire observations and stale candidates
pke metrics                          capture rate, pack coverage, staleness
pke mcp                              MCP server over stdio
pke serve --http                     MCP server over streamable HTTP
```

---

## Status and limitations

Beta. Working and tested, validated against one real project, not yet battle-tested across many.

**Known limitations:**

- Single-user, no auth, localhost only
- No UI. Triage is a CLI list
- No semantic search. Relationship, metadata, and keyword retrieval only
- Duplicate detection is structural (title similarity), and runs on import but not on live candidates
- Discussion transcripts over 32KB have no blob storage yet
- Staleness thresholds (90/180/30 days) are placeholders with no empirical basis

`docs/00-open-amendments.md` lists known design gaps with their reasoning. `docs/build-log.md` records where the specification turned out to be wrong and why.

---

## Contributing

Issues and PRs welcome. Response is weekends-only — treat this as a tool that works rather than a project with a roadmap.

Two things that will get a PR rejected regardless of quality:

- **A model vendor SDK in `package.json`.** The engine never calls a model. This is structural, not a preference.
- **A schema-owning ORM.** Migrations are hand-written SQL because the schema depends on triggers, `ltree`, partial indexes, generated columns, and CHECK constraints that ORMs drop or fight. Query builders are fine.

The `docs/` directory contains the full specification: vision, domain model, PRD, technical specification, and deployment. If you are changing behaviour, the spec is authoritative and should change first.

---

## Licence

MIT
