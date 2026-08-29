# Build log

Closed findings from implementation. Not a specification. Not the open-amendments register.

---

## Scopes and labels (through 002)

**Composite PK and the single-row / multi-row asymmetry.** MTS 3.4.1 sketched `feature_labels.id` as a single-column primary key. A merge that `UPDATE`s `redirects_to_id` in place makes a pack rebuilt at the pre-merge version follow the post-merge redirect and fail the hash. Implementation used `PRIMARY KEY (id, valid_from_version)` plus a partial unique index on open `id`: close the old window, insert a new row with the same identity. That is the first case where the specs did not survive contact with code, and it was a real defect, not a taste difference.

The reason determines 003+. `knowledge_objects` and `relations` stay **one row per id**: the only status changes after approval are to terminal states, and terminal states are excluded from packs, so leaving `active` and closing the version window are the same event. `feature_labels` and `feature_label_aliases` are **multiple version-windowed rows per identity**: `deprecated` and a non-null `redirects_to_id` change resolution without removing the label from resolution. One row cannot represent both pre- and post-merge behaviour. Now normative in MTS 2.2, 3.4.1, and 3.4.4.

**Alias primary key.** Aliases have no FTL-style id. Identity is `(project_scope_id, alias)`. Primary key is `(project_scope_id, alias, valid_from_version)`, with a partial unique index on the open pair. Same version-window pattern as labels, different identity.

**Named volume.** `compose.yaml` used a bind mount at `./.docker/pgdata`. `docker compose down -v` does not remove bind-mount directories, so `make fresh` left stale schema in place. Switched to a named volume `pgdata`. Recorded in 05 §5.1, §5.2, §5.6.

**Migration versions.** `schema_migrations` recorded the zero-padded prefix as text (`"000"`, `"001"`) while the runner sorted numerically. Two orderings over the same data. The column is now `integer` primary key; the full filename is stored separately; uniqueness and contiguity from 0 are asserted at startup.

**`graph_versions.object_ids`.** Widened from "knowledge objects" to identities whose validity window changed (knowledge objects, relations, registry rows). Prefixes are the namespace. A label merge records `FTL-…` ids so pack-diff at that version is not an empty array.

---

## Knowledge object acceptance and write path (through 011)

**Approval is insertion, not a state transition.** The implementation made the model explicit: Reviewed and Operational objects cannot legally exist with `approved_at IS NULL`, while Raw objects cannot later acquire approval. Candidates are a separate table, so acceptance inserts the object directly in its type's initial durable state with `approved_at` and `last_verified_at` set, inside the curation transaction. This is the second specification defect found by implementation: the approval-transition framing in MTS 5.1 and 5.4 was inconsistent with the actual Candidate and object model. The signal was a test that could not be written—there is no legal row on which to exercise an approval UPDATE. The test now asserts that `approved_at` cannot be changed on any existing row.

**Generated columns in a BEFORE UPDATE record.** The 007-era append-only trigger compared `to_jsonb(NEW)` and `to_jsonb(OLD)` after removing the six mutable columns. PostgreSQL leaves the generated `knowledge_class` field null in `NEW` during a BEFORE UPDATE trigger, while `OLD` contains its stored value. The mismatch falsely rejected every otherwise-whitelisted update; it was not a side-effect change caused by the whitelist write. Migration 008 excludes the generated field from that comparison, and migration 009 makes approval explicitly insert-only. Any future generated column must be excluded from this style of BEFORE-trigger comparison or compared explicitly.

**INV-10 was initially direct-edge-only.** The first implementation flagged only Decisions with a direct `derives_from` edge from the changed Requirement, while MTS 8.6 and PRD-REQ-006 require transitive propagation through Decision chains. This is the third specification-versus-code gap, and the first where the code was narrower than a correct specification rather than the specification being wrong. Migration 010 adds the recursive, depth-64 traversal.

**Multi-element Candidate version granularity is a spec change driven by implementation.** MTS 8.2 and 14.3 previously said that each accepted child was its own curation transaction. Implementing TC-2 exposed the conflict: a Decision plus its derived Constraints is one coherent knowledge change and must share one graph version. The reconciliation preserves PRD-CUR-007's element-level accept/reject choice, then promotes the curator's chosen accepted subset atomically in one curation transaction; unchosen elements remain pending. This is a specification change with a rationale, not a wording-only update.

**INV-10's depth bound has a silent false negative.** A Decision whose only path from a superseded Requirement lies beyond the recursive depth-64 bound is not flagged, and no error or incomplete-impact marker is emitted. The bound correctly prevents runaway traversal, but the result is silently incomplete. MTS 8.6 specifies the limit but not whether truncation should be reported or fail. This is recorded for a later decision, not fixed in this slice.

---

## Retrieval and Context Pack assembly

**The A1 validity-window candidate fix was insufficient.** Replacing
`active` with a version-window predicate corrected the literal mismatch for
rejected Hypotheses, observed Observations, open Open Questions, and current
Artifacts, but it did not express the status semantics of each pack section.
The existing schema also closes a predecessor's half-open validity window at
the graph version that supersedes it, while the product explicitly retains
recently superseded Decisions as historical pack content. A single
version predicate therefore either drops that product content or makes all
terminal objects visible.

The resolved contract is two predicates: the object's applicable version
window and the section's explicit status predicate. Recent Superseded
Decisions are the only historical exception, selected by `status =
superseded` plus a bounded closed-window test (the last 10 graph versions).
The day-based arm is excluded so selection remains a pure function of request
and graph version. No other terminal state is implicitly pack-visible. The
finding is recorded because the first implementation-shaped fix was narrower
than the actual pack contract, not because the append-only window model was
wrong.

**Migration 012 rewrote the INV-7 trigger instead of extending it.** To add
`search_vector` to the generated-column whitelist, 012 replaced the trigger
function wholesale. That replacement silently dropped the explicit
`approved_at` immutability check and the `knowledge_class` exclusion that
migration 009 had added. The raw-SQL bypass tests caught the regression:
attempting to assign approval to a Raw row reached the
`knowledge_objects_approved_class` CHECK instead of failing at INV-7 with
`IMMUTABLE_AFTER_APPROVAL`. Migration 012 now preserves all three generated
column/approval protections, and migration 013 repairs installations that
already recorded the original 012. The lesson is that additive changes to a
multi-invariant trigger must be additive in the migration, not a rewrite.

---

## First hand-authored backfill attempt

The first worked import attempted to make ADR-001 approval-ready by creating
`DSC-0001`, a fabricated Discussion that merely restated the Decision,
pointed `content_ref` at `docs/mira_decisions.md`, and used an invented
midnight timestamp. No such conversation exists. It was created solely to
satisfy INV-3's required `derives_from` edge.

That attempt was deleted. ADR-001 is correctly represented as an Artifact,
with `DEC-0001 references ART-0001`; the Decision has no legal origin and the
dry run reports `DECISION_ORIGIN_REQUIRED` plus a Domain Gap with
`candidate_concept = "Unrecoverable origin"` and
`recorded_as = "not_recorded"`.

This is direct evidence for A11: evidence invariants block historical import.
The importer must expose the missing origin as a gap rather than manufacture
evidence to make the dry run pass.

---

## Restoration of the shared MIRA decision log

An intermediate cleanup incorrectly treated identity differences between the
MIRA backfill log and `docs/mira_decisions.md` as evidence that the supplied
records were invalid, and removed real MIRA records from `backfill/mira`.
Those records have been restored from the curator-supplied shared log.

Duplicate resolution keeps the explicitly corrected `DEC-0006`, the fuller
`DEC-0007` record with its rejected alternative, and the corrected `CON-0002`
content. Relations are stored in `relations.json`, not inside object files.
The shared log's `moderate` reversibility values are normalized to the Domain
Spec enum value `costly`; `XRF-0001` uses the enum value `other` for its
incident source and is kept outside `objects/` because External Reference is
not a Knowledge Object.

The ID mapping against the decision ledger remains an audit question, not a
basis for deleting the supplied records. Missing `derives_from` origins remain
validation failures and must be resolved with real evidence or recorded as
gaps; no synthetic Discussions are to be created.

---

## Amendment A-BF-1 — Backfill mode was specified but not implemented

The backfill tool was specified as a distinct mode in MTS §22, but every
invariant and lifecycle gate had been written against the live capture path.
This was the **sixth specification-versus-code finding**, and the largest:
the mode existed in the product contract while the implementation had no
trust boundary for it.

The correction is deliberately narrow. The importer now creates a
`backfill_mode` curation transaction; the graph version records that marker,
and an architectural lint rule keeps the capability out of live write
barrels, MCP, and CLI paths. Backfill-only Decisions may positively assert
`origin = "unrecoverable"`; live capture rejects that marker and a Decision
with neither a marker nor a `derives_from` edge still fails INV-3. Historical
terminal states are accepted directly only where the surviving outcome is
the reason the record exists. Structural near-duplicates are reported as
dry-run warnings and are never silently merged.

This preserves the evidence and lifecycle rules for live capture while
making the historical import path honest about what cannot be recovered.

---

## Real MIRA backfill at graph version 727

The A-BF-1 backfill was run for real after the dry run passed. It committed
exactly one graph version, `727`, with six relations and 23 object rows:
11 Decisions, five Constraints, five Glossary Entries, one Hypothesis, and
one Artifact. All 23 rows are `authored_by = human` with a
`backfill:` source marker; all 11 Decisions carry
`origin = "unrecoverable"`; and `HYP-0001` is `rejected`.

The earlier friction record's “20 authored files” is a historical authoring
count. The final `backfill/mira/objects/` directory contained 23 files, so
the committed row count is 23, not 20. This discrepancy is recorded rather
than silently changing the append-only graph.

The import contained zero feature labels because no object file supplied
`feature_labels`, and the Project label registry was empty. At that point,
changing `feature_label_ids` after approval was forbidden by INV-7, so the
feature-filtered pack remained unbuilt. This was registered as A17 rather than
inventing successors or a supersession history.

---

## Amendment A17 — Feature labels are filing, not assertions

A17 resolves the finding by adding `feature_label_ids` to the INV-7 whitelist.
The application exposes relabelling only through a curator curation
transaction; the database append-only trigger and domain append-only check
agree with that boundary. The transaction creates one graph version, records
the affected label and object identities, and changes no approved assertion.
It never supersedes an object.

The rationale is the distinction in MTS §11.2: scope answers “at what level is
this true” and is an assertion about the world, while a feature answers “what
is this about” and is navigation. Superseding an object only to file it would
create ids, chains, pack diffs, and change-impact edges that claim a content
change where none occurred.

The accepted v1 reproduction hole is explicit: an object's
`feature_label_ids` is not version-windowed. Rebuilding an old pack resolves
the label registry at the requested graph version but reads the object's
current label set. This is accepted because labels are navigation rather than
history; reproduction must report the limitation.

The follow-up relabelling transaction committed graph version `728`. It
created `FTL-0001` (`magic-link`) and `FTL-0002` (`event-lane`) and assigned
them to the curator-specified MIRA objects without superseding any row:
`magic-link` to `DEC-0006` and `CON-0003`; `event-lane` to `DEC-0004`,
`DEC-0005`, `DEC-0009`, `DEC-0010`, `DEC-0011`, `CON-0004`, `CON-0005`,
`GLO-0004`, and `GLO-0005`. Pack 3 was then built at version `728` with
`intent = implementation`, `budget = 4000`, and `feature = magic-link`.

---

## A19 — Real graph contains erroneous pre-isolation captures

**Closed by Amendment A19 (Domain Spec v1.6).** Terminal status `retracted`
is now available on every Knowledge Object type by explicit curator action.
Retraction excludes the object from packs at and after the retraction version,
retains the row and relations for audit, does not claim the object was ever
valid knowledge, and is not retroactive.

The twelve legacy global rows were removed by the A20 file rebuild; the
retraction mechanism remains the honest in-graph correction when reset is not
appropriate or contamination must stay auditable.

---

## A20 — The graph is not reproducible from files

The MIRA directory contains 23 Knowledge Object files, all 23 of which were
imported at graph version `727`. The “20 objects imported” figure was an
authoring-count error, not a silent skip: no object file was rejected or
omitted. `relations.json` contains six relations and
`external-references.json` contains `XRF-0001`.

The scope-tree seed and all feature-label registry entries and assignments are
database-only. MTS §22 specified declarative Knowledge Object and relation
files, but never specified declarative scope or label creation because those
are not Knowledge Objects. The result is that the intended graph cannot be
rebuilt on another machine or reset after A19 without a PostgreSQL backup.

This is larger than A19. A19 concerns the absence of an honest removal verb
for an erroneous object; A20 concerns the absence of a complete reconstruction
source for the graph itself.

The candidate fix is to add version-controlled scopes and labels manifests,
with label assignments represented separately as a curation transaction. It
was implemented as A20.

`scopes.json` now declares the complete MIRA tree, including the migration
root. `labels.json` declares the two Project labels and their assignments.
The importer applies scopes, object/external-reference/relation content, and
labels/assignments in that order as three transactions. On a clean database
the resulting versions were:

- v1 `backfill.scopes`: seven new MIRA scope nodes (Global already exists from
  the migration).
- v2 `backfill.import`: 23 Knowledge Objects, `XRF-0001`, and six relations,
  with `backfill_mode = true`.
- v3 `backfill.labels`: two labels and their eleven assignments.

The import report contained zero failures, six duplicate warnings, and no
gaps. A direct database check found 23 objects, all `authored_by = human`
with `backfill:` source markers; all 11 Decisions carry
`origin = "unrecoverable"`, `HYP-0001` is `rejected`, and zero objects are
scoped to Global.

The rebuild test created two independent databases from migrations plus the
files and produced byte-identical Context Pack `content_hash` values at
equivalent graph version 3. Re-importing unchanged files created no version;
a conflicting scope definition failed before writing.

Finally, the live `pke` database was dropped, recreated, migrated, and
rebuilt only from the version-controlled files. This is a scratch graph reset,
not a knowledge deletion verb. The three MIRA packs were rebuilt at v3:
implementation retained 20 objects and dropped `ART-0001` and `HYP-0001`;
debug retained the same 20 and dropped `HYP-0001`; the `magic-link` filtered
implementation pack retained 18, including all five Constraints, and excluded
the event-lane-labelled Decisions. The `unrecoverable` marker rendered on
every retained Decision.

---

## MCP access layer — empty inputSchema stripped client arguments

The first MCP integration registered all four tools with `inputSchema: {}`.
The MCP SDK treats that as a Zod object schema with no properties, which
**strips every client-supplied argument** during parse. Handlers then received
`{}` and returned `"scope is required"` even when the client had sent a
scope. Cursor's `context_build` display name was a red herring; the wire
call reached the handler, but the transport boundary deleted the payload.

All 79 pre-transport tests called handler functions directly and never
exercised the SDK parse layer, so this bug survived the suite. Transport-level
tests now call `callTool` through an in-memory MCP client for each tool.

The fix is real per-parameter schemas with descriptions and enums, plus
underscore aliases for clients that normalise dotted names. Scope discovery
is exposed as `graph.expand` with `list_scopes=true`, not a fifth tool.
Temporary stderr logging of raw post-parse arguments is enabled for one
debugging cycle against Cursor.

---

## `transitionObject` hid rejected Hypotheses from every pack

`transitionObject` used a flat terminal-status set and closed
`valid_to_version` on any status in it. `rejected` was in that set, but
Domain Spec §5 and Master Tech Spec 5.6 state rejected is **not** terminal
for Hypothesis because revive is legal, and rejected is the only state in
which a Hypothesis appears in a Context Pack (Domain Spec 4.4).

Effect: rejecting a Hypothesis recorded the negative knowledge and
simultaneously hid it from every pack. This would have applied to every
Hypothesis in the system.

Found by checking pack output after a live transition, not by any test.
Fixed by using `isStatusTerminal(type, status)` so the window closes only
for type-specific terminal states.

The class of bug is a status-handling rule applied uniformly across types,
where the domain model defines it per type. Worth checking whether the
same pattern exists elsewhere.

---

## `PROVENANCE_REQUIRED` gave callers nothing to act on

An external caller (Fovea) filed `discussion.resolve` twice with
near-identical payloads and got the same rejection both times:
`"DSC-... is missing required attributes"`, code `PROVENANCE_REQUIRED`.
The caller's model guessed the missing field was named `provenance`
(matching the error code) and added an attribute by that name. It was
wrong — the actual gap was `discussion.attributes.content_ref` — and the
identical retry proved the message gave it nothing to correct against.

Two compounding causes, not one:

- `checkEnvelope`'s `attributes` presence check (`domain/invariant/check.ts`)
  fired `PROVENANCE_REQUIRED` for four unrelated conditions: a
  `knowledge_class`/`type` mismatch, a raw object wrongly carrying
  approval, a reviewed/operational object missing actual provenance
  (`approved_at`/`last_verified_at`/`authored_by`), and a type missing
  attributes from `requiredAttributeKeys`. One code covering four causes
  is not diagnosable from the code alone, and the message named the
  object, never the field.
- The MCP tool schema for a knowledge-object write
  (`mcp/schemas.ts`) types `attributes` as a fully open
  `z.record(z.string(), z.unknown())`. Nothing in the schema a caller
  can introspect says which keys a given `type` requires — that list
  (`requiredAttributeKeys`) exists only inside the domain check. The
  rejection message is the only feedback channel there is, for every
  knowledge type, not just Discussion.

Fixed by splitting `PROVENANCE_REQUIRED` into four codes matching the
four conditions it used to share (`KNOWLEDGE_CLASS_MISMATCH`,
`RAW_APPROVAL_FORBIDDEN`, `PROVENANCE_REQUIRED` — kept for the one case
that is actually about provenance, per MTS INV-2 — and
`REQUIRED_ATTRIBUTES_MISSING`), and by having the missing-attributes
message name the specific missing keys plus the type's full requirement,
e.g. `"DSC-1 is missing required attributes: contentRef (discussion
requires medium, occurredAt, contentRef)"`. `requiredAttributeKeys`
itself did not change; only its result is now surfaced instead of
discarded. `OBSERVATION_EVIDENCE_REQUIRED`'s special case inside
`checkEnvelope` was removed as redundant now that the generic message
names Observation's fields too; the separate, stricter check for an
empty-string `evidence_ref` (`assertInvariants`/`assertGraphAdditions`)
is untouched and still uses that code.

The open schema-vs-validation gap is not fixed here and is not
Discussion-specific: every knowledge type's per-type required attributes
live only in `requiredAttributeKeys`, invisible to a caller reading the
tool's input schema. A caller can still only discover them by getting
rejected once. Worth revisiting if this MCP surface grows more external
callers.

---

## Sixth finding — validation and persistence used different objects

Validation ran on a normalised copy while persistence used the raw input.
The domain layer appeared to gate writes and did not. Found by an MCP
caller, not by tests, because tests constructed either already-normalised
domain objects or already-storage-shaped writes and never exercised the
conversion boundary.

Three write paths reached SQL without the domain gate actually gating:
`discussion.resolve` validated a copy, while triage acceptance and
`supersedeObject` validated nothing. The first could report a valid
proposal and then fail PostgreSQL's `knowledge_objects_attribute_keys`
constraint; the latter two relied on SQL and path-specific checks rather
than `assertGraphAdditions`.

The live paths now materialise without inventing missing values, validate
the exact additions against current graph state, and explicitly project
the validated domain representation to storage-shaped attributes before
insertion. Candidate acceptance repeats this immediately before approval;
proposal-time validation is not treated as proof that the later graph
state is still valid.

Backfill had the same representation hazard through a separate
cast-based synthetic object: validation accepted camelCase aliases but
the write plan copied raw attributes that PostgreSQL expected in
snake_case. It now uses the common non-coercive materializer and the same
explicit storage projection as live writes, so dry run and import operate
on one canonical representation.

`ART-0201` was created by supersession before this gate was added and was
therefore never domain-validated on write. It happens to be well-formed.

---

## Seventh finding — the contract was unreachable from the tool schema

Fovea's model failed five consecutive `discussion.resolve` calls. It
never once sent the four required Decision attributes and tried three
different status values for each object. It was guessing because nothing
told it: `attributes` was `z.record(z.string(), z.unknown())` and
`status` was an unconstrained string, so the advertised schema stated
that any object with any keys was acceptable. Two further requirements —
a Decision needs a `derives_from` edge, a non-axiomatic Constraint needs
a Decision parent — were invisible in a `relations` field the schema
marked optional. Attempt 5's reported error, that the discussion ID
lacked "the required initial status in its records", was the model
paraphrasing; the server said `DSC-... must use initial status recorded
for discussion`, and the invented "in its records" sent it looking for a
lookup problem that does not exist on this path.

The per-type contract was written out seven times: `requiredAttributeKeys`
(camelCase), the materialiser, the storage projection (snake_case),
`BACKFILL_TYPE_SPECS`, the two database CHECK constraints, and
`docs/22-backfill-quickref.md`. `KNOWLEDGE_TYPE_CONTRACTS` in
`domain/entity/contract.ts` is now the single source: initial status,
status lifecycle, and each attribute's two spellings, required flag, and
value kind. Three consumers are derived from it (the Zod input schema,
`requiredAttributeKeys`, `BACKFILL_TYPE_SPECS`) and four are pinned by
`tests/type-contract.test.ts`. The materialiser and storage projection
stay hand-written because their switch statements are what give
`Decision["attributes"]["reversibility"]` a compile-time type; the test
asserts their key sets match instead. The database constraints are read
from the live schema with `pg_get_constraintdef()`, not parsed from
migration files: `knowledge_objects_status_for_type` is defined in
migration 003 and redefined in 018, so a file-parsing check would have
been testing a constraint that no longer exists.

`discussion.resolve` now advertises a discriminated union over `type`,
generated from that table, so a client reading `tools/list` sees
`required: ["statement","rationale","reversibility","alternatives_rejected"]`
under a Decision, `reversibility` as an enum of three values, `status`
as a const, and only the seven proposable types. camelCase attribute
aliases are still accepted: they are normalised onto the canonical
snake_case key before validation rather than being declared as an
either-or, because Zod skips refinements once a sibling field has failed,
which would have reproduced the one-error-per-round-trip behaviour the
schema exists to remove.

---

## Length caps dereferenced values whose type nothing guaranteed

Separate from the accumulator work below, and live before it.
`checkLengthCaps` read `attributes.rule.length` directly. Presence of
those keys is guaranteed by `checkEnvelope` and by the database, but
neither guarantees a string: PostgreSQL's `?&` operator tests for key
presence only. An object stored with a numeric `rule` therefore passes
both gates and crashes the invariant pass with a `TypeError` instead of
returning a `DomainError`. Fixed by measuring length only when the value
is a string.

---

## Eighth finding — one rejection per round trip

The five failed attempts each fixed one thing and learned one thing,
because `validateDiscussionProposal` threw on first failure while the
backfill dry run had reported every failure at once since it was
written. Attempt 5 is the clearest case: a wrong discussion status
masked four missing Decision attributes and a wrong Decision status,
because the discussion is checked before anything in `proposal.objects`.

`assertGraphAdditions` is now a wrapper over `collectGraphAdditionFailures`,
which runs the same rules in the same order and records rejections rather
than propagating them, so `failures[0]` is exactly what the throwing form
used to report and every existing caller is unaffected. Rules that would
read data a previous rule just reported as missing are skipped for that
object, following the backfill validator's pattern.
`validateDiscussionProposal` accumulates its own structural checks the
same way and throws one `AggregateDomainError`, whose `code` and
`message` remain the first failure's so clients keying on them do not
break. The MCP error body carries the full list under `error.failures`.
Structurally impossible payloads still stop early: continuing past a
malformed object would report failures about an object the caller never
described. Relations with unknown endpoints are dropped rather than
carried into the graph checks, which would otherwise report the same
relation twice under a less actionable message.

---

## Ninth finding — an identity the caller could not construct

Attempt 6 was correct in every respect the previous five were not:
right statuses, all four Decision attributes, `alternatives_rejected`
properly shaped, `derives_from` present, snake_case throughout. It was
rejected for its ids. `DSC-ENGRAM-20260823-001` is not
`^DSC-[0-9]{4,}$`.

The rule is prefix plus at least four digits, numbered per prefix, and
the caller has no way to satisfy it. Nothing publishes the next free
number, `graph.expand` does not report one, and two agents resolving at
the same moment would have picked the same one anyway. The Zod schema
asked only for a non-empty string, so the rule was first stated by a
Postgres CHECK, surfacing as `INTERNAL_ERROR` — a constraint name, at
the far end of the call. Documenting the format better would still have
left the caller guessing at a number.

So Engram now owns discussion identity. The caller supplies `local_id`,
a handle with meaning only inside one payload, defaulting to
`"discussion"`; relations point at that handle; the allocated id comes
back as `discussion_id`. Allocation happens inside the same transaction
as validation and both inserts, under a transaction-scoped advisory lock
taken per prefix. Allocating outside the transaction, or without the
lock, would only move the race from the caller to the server: both
sessions would read the same `MAX` and the loser would fail on the
primary key after doing all of its other work. The test for this fails
when the lock is removed. Numbering stays `MAX + 1` rather than a
sequence because backfilled ids are sparse and were assigned outside this
engine, so a sequence would need reseeding after every import.

Proposal objects still carry caller-supplied ids for now, but the format
is derived into their branch of the schema, so an attempt-6 id is now a
`-32602` naming `proposal.objects[0].id` rather than a CHECK violation
at acceptance. Step two removes those ids too.

The prefix CHECK was the ninth encoding of the per-type contract and the
last unpinned one. `idPatternSourceFor` now derives it from the contract
table, the parity test compares it against `pg_get_constraintdef`, and
the dead `ID_PREFIX` map in `entity/types.ts` — a tenth copy, unreferenced
— is deleted.

### What a client sees differently

- A discussion with an `id` is rejected at the boundary: `-32602`,
  `discussion.id`. It is not silently ignored, because a caller that
  believed it had named the object would misread the response.
- A discussion needs no id. `local_id` is optional and defaults to
  `"discussion"`.
- A proposal object whose id is not `PREFIX-NNNN` is rejected at the
  boundary rather than reaching the handler.
- `discussion_id` in the response is now the authority on what was
  written; it is no longer echoing the caller's input.

---

## Attempt 7 — a correct rejection, reported to the user as a success

Attempt 7 was rejected with `IMMUTABLE_AFTER_APPROVAL` — the model
guessed `DEC-0001`, which is MIRA's backfilled decision. Engram behaved
correctly: one round trip, named code, offending id, clean rollback,
nothing written.

The calling model then reported to its user that the decision "already
exists in Engram as DEC-0001", presenting a rejected write as a
completed one. This is the fifth time a caller has paraphrased an Engram
error into something materially wrong, and the first time the paraphrase
inverted the outcome.

Note the implication: error text quality has been improved twice and
callers still misreport. Structured failure data now exists on
`error.failures`; whether clients surface it is outside Engram's
control.

---

## Local ids — Engram owns identity end to end

Attempt 7's id was well-formed and still wrong, because the caller
cannot know which numbers are taken. Fixing the format only moved the
guess. So a Candidate no longer carries graph ids at all: each proposed
object is named by a `local_id`, a handle with meaning inside one
payload, and relations are written against those handles. Engram
allocates the graph id at acceptance, in the curation transaction,
through the same per-prefix advisory lock the discussion allocation
uses.

A handle shaped like a graph id is refused at the wire boundary.
Endpoints resolve against handles first, so a handle spelled `GLO-0007`
would silently shadow the approved object of that name — the one
ambiguity this design could introduce, removed where it is cheapest.
With that guarantee the duplicate-id check against the graph is gone
from the propose path: proposed handles are checked only against each
other, because they can no longer collide with anything approved.

Two consequences worth stating. A local handle is not unique across
Candidates, so two proposals may both call their decision `decision` and
both accept; they receive different ids. And a Candidate accepted in
parts must resolve handles its earlier siblings already assigned, so
acceptance records the mapping in `resolution.assignedIds` and later
acceptances read it. Nothing rewrites a stored payload in place.

The reader tolerates both shapes. The four historical Candidates carry
real ids, keep them, and are migrated by nothing; `payloadIdentity` is
the single accessor every reader uses, replacing the two near-identical
implementations in `aggregatePayload` and the CLI's `editPayload`, which
would have drifted. Triage shows the handle before acceptance and the
assigned id after.

Editing a handle is now refused. Under caller-supplied ids that edit was
meaningless but harmless; under local ids it detaches every relation
resolving against the old handle, so it is rejected rather than
silently reinterpreted.

### What a client sees differently

- `proposal.objects[].id` is refused. `local_id` is required on each
  proposed object, and refused if it looks like a graph id.
- `validation.objectIds` is now `validation.localIds`. The old name
  described ids that no longer exist at proposal time.
- Triage results carry `assignedIds`, the handle-to-id mapping for the
  elements that acceptance named, alongside the existing `objectIds`.
- `IMMUTABLE_AFTER_APPROVAL` is no longer reachable from
  `discussion.resolve` for a proposed object. It was only ever reachable
  by guessing.

---

## `$EDITOR` committed an AI-authored payload as curator-reviewed

`pke triage edit` opened a temp file in `$EDITOR`, waited for exit, and
read the file back. A GUI editor invoked without a wait flag forks and
returns 0 immediately, so the untouched buffer was read back, parsed
cleanly, and committed — recorded as `edit_and_accept`, which asserts a
human reviewed an object nobody had seen. The one guarantee triage
sells, that nothing durable is written without explicit human
acceptance, was defeated by an editor's exit convention.

Found by reading the code during the Epic 1 investigation, not by a
test. Both existing editor tests use editors that either fail or
genuinely modify the file, so neither could observe the case; a passing
suite was consistent with the defect being live.

There is no way to distinguish an unmodified buffer from a genuine no-op
edit, and no blocklist of editor names catches the editor nobody thought
of. So the file's bytes are compared before and after, and an unchanged
file is always a refusal: exit non-zero, name `--payload`, commit
nothing. The temp file survives every failure — on the GUI path an
editor window is about to open onto it, and on a parse failure it holds
work the curator would otherwise lose.

The refusal needed a way out that was not an editor, which is what
`--payload <file|->` and `pke triage payload` are for. They also happen
to be what a non-interactive caller needs, so the fix and Epic 1's
requirement are the same code.

---

## Logged, not fixed — `pack diff` on one connection

`pack diff` issues its two pack loads concurrently against a single `pg`
client and passes pack ids to the driver without validating their shape
first. A `pg` client is not a pool and does not multiplex; concurrent
queries on one connection are serialised at best and interleave
protocol state at worst. Recorded here rather than fixed inside Epic 1,
which is about the CLI's output contract, not its query layer.

---

## One flag, one selection, one implementation

Triage grew two implementations of the same question — which elements of
a candidate group does this command apply to. `selectCandidates` in the
write path and `pendingSelection` in the CLI each resolved the default,
checked membership, and checked pending status, in the same order with
different words. They had not yet disagreed. Nothing prevented it, and a
disagreement would have shown up as `accept` and `edit` operating on
different sets from the same arguments.

The selection flag had three spellings, of which one was documented.
`--elements` is now the only one; `--element` and `--only` are refused
by name, pointing at the flag that works, rather than dumping usage
text. The default is stated in the usage text and repeated in the error
raised when a selection resolves to nothing, because "candidate group
has no pending elements" is only actionable next to what omitting the
flag would have meant.

`merge` had no selection flag at all. On a multi-element group it
failed with "merge requires exactly one candidate object and a target",
which names the problem and not the fix. It now takes `--elements` like
its siblings, and says which one to pass.

### The plain-`Error` sweep

Three separate findings this epic were the same defect: a failure a
caller must distinguish, thrown as a bare `Error` and therefore arriving
as `INTERNAL_ERROR`. Rather than name a code each time one surfaced,
every throw on a curator command path was converted at once —
`INVALID_USAGE`, `INVALID_ARGUMENT`, `INVALID_PAYLOAD`,
`OBJECT_NOT_FOUND`, `EDITOR_UNAVAILABLE`, and the `CANDIDATE_*` family.
Inside `candidates.ts` the code argument is required, so a new failure
cannot inherit `ILLEGAL_TRANSITION` from a default the way "candidate
does not exist" previously did.

Genuine internal invariants — "relation insert did not return an id",
"curation transaction produced no graph changes" — stay bare. They are
not conditions a caller can act on, and `INTERNAL_ERROR` is the honest
report. The line is whether the caller can do anything about it.

---

## `runCli` returns a result; the entry point owns the exit code

`runCli` printed its own output and set `process.exitCode` on the `--json`
path, while bare failures escaped as exceptions for the entry point to
catch. Two mechanisms for one outcome, and neither observable: a test
could assert that a promise rejected, or capture `console.log`, but not
read what the terminal would have shown.

It now returns `{ exitCode, stdout, stderr, payload }` and writes
nothing. The entry point prints the streams and sets the code. A command
failure is a return value rather than an exception, including a bug in
Engram — anything escaping `dispatch` becomes a non-zero result, so no
caller can observe a failed command as a silent success.

`payload` is the value `stdout` was serialised from. It is redundant on
purpose: a test that only reads `payload` never proves the bytes parse,
and one that only parses `stdout` asserts against untyped data. The
envelope test does both and checks they agree.

### The refactor found two silent failures

Converting `runCli` from throwing to returning removed the implicit
assertion every existing test was relying on without stating. Nine call
sites read `await runCli([...])` and discarded the result, and two of
them had started failing: an artifact id shaped like a timestamp
overflowed the bigint the id allocator parses out of `ART-NNNN`, and
`supersede` was returning non-zero into a void. The tests still passed,
because the only thing that had ever made them fail was an exception.

This is the same class as the validate/persist split recorded above: a
suite internally consistent enough to pass while checking nothing. There
the two sides agreed with each other and not with the database; here the
assertions agreed with a control-flow contract that no longer existed.
Neither was caught by the suite, because in both cases the suite was the
thing that was wrong.

Every call site now asserts its exit code through a helper that names
the command and the reason — reading the reason out of the `--json`
payload when there is no stderr, since a bare `exitCode` assertion
reports that something failed without saying what.

The `console.log` capture helper introduced one step earlier is gone,
which is the marker that the refactor landed rather than being worked
around.

### What the tests now cover

- Every command in requirement 1.1 under `--json`: the envelope parses,
  agrees with `payload`, carries `command`, `graph_version` and `data`,
  contains no camelCase key at any depth, and emits no ANSI. Writes
  carry a version too, which is the point of putting it on all of them.
- `triage edit --payload` with `$EDITOR` and `$VISUAL` unset, and the
  refusal that names `--payload` when neither is available.
- An unchanged editor buffer: `EDIT_UNCHANGED`, no version, candidate
  still pending, object absent.
- A failing command: non-zero, structured `failures[]`, with `code` and
  `message` mirroring the first entry.
- Eight failure modes across the write path, each asserting the graph
  version is unchanged after the failure is reported. No command commits
  and then reports failure.

---

## Concurrent queries on one client — the sweep found seven, not two

Epic 1 logged the pattern in `diffStoredContextPacks` and `listTriage`
and deferred it. Sweeping for the shape rather than fixing the two known
sites found it in seven functions across six files: `listTriage`,
`showKnowledgeObject`, `listKnowledgeObjects`, `listScopeTree`,
`requirementImpact`, `getArtifact`, and `diffStoredContextPacks`. That
is every read command the curator has — `pke show`, `list`, `impact`,
`scope list`, `triage list`, and `pack diff`.

Each had the same shape: `Promise.all` over two or three loaders that
each issue queries on the same client. A `pg` client is not a pool and
does not multiplex, so the queries are serialised at best and interleave
protocol state at worst. They were all reads against a quiet
single-user database, which is why nothing had gone visibly wrong.

`loadPackWorkingSet` was already sequential internally. The concurrency
came entirely from composing it with a graph-version read in a
`Promise.all`, which reads as parallelism and is not.

### Asserting it directly rather than watching for the warning

`pg` emits a deprecation warning for this, and the warning was the
symptom that surfaced it. The test does not watch for it. The warning is
scheduled to become a removal in pg@9, so a test keyed on it would go
quiet exactly when the behaviour became fatal rather than merely
undefined.

Instead the client is wrapped in a proxy that counts in-flight queries
and records any that begin while another is running. Each read entry
point is driven through it, so a failure names the function rather than
the command. The test was confirmed to fail — naming `listTriage` — by
reintroducing the `Promise.all` before it was trusted.

Not fixed, and worth stating: the working set and the graph version are
still read as two statements outside a transaction, so a concurrent
write between them could pair a working set with a version that does not
describe it. V1 is single-curator and nothing writes concurrently, but
pack assembly's determinism rests on that pairing.

---

## A malformed id is the caller's mistake, not an Engram bug

`pack diff` passed ids straight to the driver, so `not-a-uuid` came back
as `INTERNAL_ERROR: invalid input syntax for type uuid`. That tells a
caller its request triggered a defect in Engram, when in fact the caller
passed something unusable — and it is the one failure class a UI can
resolve without a human.

The gap was wider than logged. It covered `pack reproduce` and every
`triage` subcommand, because Candidates and stored packs are keyed by
uuid. Commands taking a knowledge-object id are unaffected: those
columns are text, so `pke show DEC-nope` was already `OBJECT_NOT_FOUND`.

Validation sits at the two points every path funnels through —
`loadCandidateGroup` and `loadContextPackRecipe` — rather than at each
command, so a new command cannot acquire the gap by forgetting to check.
`diffStoredContextPacks` additionally checks both ids before looking up
either: now that the two loads are sequential, lazy validation would
report a malformed right id only after the left one resolved, and a
caller holding two bad ids would fix them one round trip at a time.

A well-formed id that names nothing stays `PACK_NOT_FOUND` or
`CANDIDATE_NOT_FOUND`. "Not a uuid" and "no such pack" are different
questions and a caller acts differently on each.

---

## The version is the snapshot

The read-pair race logged above is closed. The working set and the
graph version were read as two statements with no shared snapshot, so a
write landing between them paired state with a version that did not
describe it.

Two options were on the table: read both inside one transaction, or use
a snapshot the version is read from. The second was chosen, and it
amounts to reading the version *first* and filtering the state to it.

The reason is that the graph already guarantees what a transaction would
have to provide. Rows are append-only and versions are monotonic, so
anything committed after a version was read carries a
`valid_from_version` above it, and a validity window closed afterwards
closes at a version above it too. "The graph at version v" is therefore
immutable the moment v exists. Reading state *later* than v and
filtering to v yields exactly the graph at v, whatever else has
committed in between.

A `REPEATABLE READ` transaction would also have worked, and a bare
`BEGIN` would not: under Postgres's default `READ COMMITTED` every
statement takes a fresh snapshot, so the two reads could still straddle
a commit inside one transaction. It was rejected for three reasons.
`buildContextPack` both reads and writes, so it cannot sit inside one
read-only transaction; it is also called from inside a caller's
transaction in the determinism tests, and a nested `BEGIN` silently
warns while the inner `COMMIT` ends the outer transaction. And an MVCC
snapshot dies with its transaction, whereas "as of v" can be re-read at
any time and gives the same answer — which is what pack reproduction
needs anyway. Correctness now rests on a domain property the product
already sells rather than on isolation configuration.

The sweep found nine sites, not the one that was logged. Three already
filter by the version they report — pack assembly, retrieval, and
proposal validation — so for those the fix was purely the ordering.
`backfill` was already reading version-first by luck. The rest —
`show`, `list`, `triage list`, `artifact get`, `impact` — reported a
version without filtering by it, and now do both.

Both envelopes had the same defect one layer up. The CLI and the MCP
handlers re-read the version *after* the command had finished, so a
response could carry two different versions: one in the envelope and one
in the body it wrapped. Both now report the version the command's own
read returned.

### Proving the test first

The pack test builds a pack while another session commits a Constraint
between the two reads, then reproduces it. Reproduction reselects from
the graph at the recorded version and compares hashes, so it is the
direct test of whether the version describes the contents.

Under the old ordering it fails with `PACK_HASH_MISMATCH`, which is the
part worth noting: the race does not surface as a race. It surfaces as
Engram loudly reporting that a pack cannot be reproduced — the alarm
that is supposed to mean the graph has been tampered with.

The first version of the test passed against the broken ordering. The
concurrent write was a Requirement, which pack assembly is entitled not
to select, so the pack was identical either way. It was changed to a
Constraint, which every pack must always inject, so a failure to see it
cannot be a legitimate selection decision.

Filtering reads by the version they report also turned an older defect
from silent into fatal. It is the more serious of the two and is its own
finding below.

---

## The current graph version was the largest string, not the largest number

A live data-correctness defect, not race hardening. It was found by
accident while closing the read-pair race and predates that work
entirely.

### The mechanism

`getCurrentGraphVersion` and `getCurrentGraphVersionOrZero` ran:

```sql
SELECT version::text, created_at
FROM graph_versions
ORDER BY version DESC
LIMIT 1
```

`version` is a `bigint`. `version::text` takes the output name `version`,
and an unqualified `ORDER BY` resolves against output column names
*before* input columns — so the sort ran on the text cast, not the
column. Text ordering puts `'9'` above `'10'`.

The bug is entirely invisible in the query. Nothing about it reads as
wrong, and the cast that causes it is there for an unrelated and correct
reason: `bigint` arrives from the driver as a string anyway, so casting
in SQL makes that explicit.

### What it affected

Every graph past its ninth version reported the wrong current version,
and kept reporting a wrong one from then on — `'9'` beats every
`'1x'`, `'2x'` and so on, so the reported version stuck near 9 rather
than drifting by one.

That value was not merely displayed. `buildContextPack` pinned it into
stored recipes, so packs recorded a `graph_version` that did not
describe the graph they were built from. Every `--json` envelope
returned it, as did every MCP response, which is the field Epic 2 has
Fovea consuming. Anything comparing against "current" compared against
the wrong number.

The dev database made this concrete: it held ten versions and reported
nine.

### Why nothing caught it

No fixture was ever large enough. A graph under ten versions agrees with
itself perfectly, and every test built its own small fixture — a scope,
a handful of objects, a curation transaction or two. The suite was not
insufficiently thorough; it was insufficiently *large*, which is a
different failure and one no amount of assertion density would have
found.

It surfaced only because reads began filtering by the version they
report. Until then a too-low version was a mislabel and nothing checked
the label. Once selection depended on it, objects above the reported
version vanished from their own listings, and two tests failed with
`OBJECT_NOT_FOUND` for an object seeded moments earlier.

Its signature in a live graph is `PACK_HASH_MISMATCH`. A pack pinned at
the wrong version reselects differently when reproduced against a
correct one, and reproduction reports that as a hash mismatch — which is
the alarm meaning the graph has been tampered with. The failure mode of
a mispinned version is therefore Engram accusing itself of corruption.

### The fix, and the instance left alone

`ORDER BY` is qualified with the table name at all three sites, so it
binds to the `bigint` column. The regression test drives a throwaway
database past twelve versions, because a smaller one cannot fail.

`relations` has the same construction and is deliberately left: it
selects `id::text` and orders by the same name, so edges come back in
lexicographic id order. Wrong in the same way, harmless in this one.
The order is stable, and every consumer sorts ids as text anyway, so
nothing downstream disagrees with it. Correcting it would reorder
selection inside packs that are already stored and break their
reproduction — the same `PACK_HASH_MISMATCH`, this time caused by the
fix rather than the bug. That makes it a migration with a rehash step,
not a one-line change, and it is not urgent because no output is
currently wrong.

---

## A false premise, an amendment nobody traced, and two honest packs

Two of the eight packs stored against the MIRA graph did not reproduce.
The audit that found them was looking for damage from the `ORDER BY`
defect and found none; these two failed for an older reason that had
been in the design from the beginning.

### The premise

Master Tech Spec §2 justified one row per identity for
`knowledge_objects` like this:

> Their only status changes after approval are to terminal states, and
> terminal states are excluded from packs, so leaving `active` and
> closing the version window are the same event.

Both halves are false. A Decision may be verified, flagged for review,
or reverted without going terminal. And terminal states are not
excluded from packs — rejected Hypotheses are the *only* form in which
a Hypothesis ever appears in one, and recently superseded Decisions
have their own section.

The second half was made false by amendment A1. A1 replaced INV-11's
single `active` predicate with two — the object's version window, and
the section's explicit status predicate — precisely so that rejected
Hypotheses, superseded Decisions, `observed` Observations, `open`
Open Questions and `current` Artifacts would be selected. That is a
deliberate, documented decision to make terminal statuses pack-visible.

Nobody traced it back. A1 was filed as a pack-assembly amendment, and
§2 is a storage-design paragraph, so the amendment closed against
INV-11, PRD-CTX-012, Domain Spec 11.4 and MTS 17.3 without anyone
asking which other decisions had been resting on the sentence it
falsified. The design decision it invalidated was two documents away
from the ones it touched, and there is no link between them in either
direction.

The consequence was not that one row per identity became the wrong
design — it is still right, for reasons the paragraph never gave. The
consequence was that status and the version window were treated as one
event when they had become two axes, so status was left as a single
mutable column with no history, whitelisted out of append-only by
INV-7, and read directly by selection.

### What that did to packs

Superseding an object sets its predecessor's `status` to `superseded`.
Rebuilding a pack pinned at a version before that supersession
re-read the *present* status, put the object in a different section or
dropped it, and produced a different hash. The pack had not changed;
the answer to "what was this object at v6" had.

`c969d4de` (pinned v6) broke when ART-0200 was superseded at v7 and
HYP-0200 was transitioned at v8. `78a8714f` (pinned v8) broke when a
hand-run repair reopened HYP-0200's validity window at v9. Both are
left unrepaired. They are accurate records of a graph that moved
underneath them, and they are the only evidence this defect ever
produced.

The blast radius was not "packs that reference a changed object". It
was every pack whose scope chain contained one, because Constraints
and blocking Open Questions are injected regardless of relevance. In
an active workstream that is most packs, and the window in which a
pack still reproduces was about three days.

### The discriminator

Reproduction raised `PACK_HASH_MISMATCH` for this, which is the alarm
meaning the graph has been altered behind the engine's back. Ordinary
curation therefore made Engram accuse itself of corruption, and a real
tampering signal would have been indistinguishable from the noise.

Every curation transaction already records the ids it touched. So
reproduction now takes the symmetric difference between the stored
selection and the reselected one and checks each differing id against
`graph_versions.action` and `object_ids` for versions above the pinned
one:

- every differing object named by a later transaction —
  `PACK_MUTATED_BY_CURATION`, and the message names the actions
- any differing object named by nothing — `PACK_HASH_MISMATCH`, and the
  message says the graph does not match its own recorded history

Both still fail loudly and neither returns a differing pack. What
changed is that they no longer make the same claim.

It is necessary and not sufficient, and the message says so: a
mutation to an object that a recorded transaction also touched is
masked by that transaction. That limit is not theoretical. The first
version of the test for "one explained object must not launder an
unexplained one" created its second object inside a curation
transaction, and the discriminator correctly reported the whole thing
as benign — the test had to be rewritten to mutate an object that
predates the pack, because anything a later transaction has touched is
exactly what the caveat describes.

### Status history

`knowledge_object_status_history (object_id, graph_version, status)`.
Selection resolves an object's status as of the requested version from
this table instead of reading the row. One resolution point in
assembly, so `sectionForObject`, `effectivePackStatus` and
`recentSuperseded` cannot disagree.

Rows are written by an `AFTER INSERT OR UPDATE OF status` trigger, not
by the three call sites that change status today. The invariant is
that no status change goes unrecorded, and a fourth call site would
otherwise have to remember. It is the same reasoning as every other
append-only trigger.

**The backfill is a guess and is labelled as one.** It records each
object's *current* status against its *opening* version. For an object
that never changed status that is exact. For one that has, the prior
status is not stored anywhere, so there is nothing to recover it from
and the row is simply wrong in a way nothing can detect. It does not
repair the two broken packs and is not intended to. Calling it a
reconstruction would make it look like the history it is standing in
for.

### `valid_to_version` needs a rule, not a history

It does not need a second history table, because closing a window is
not a retroactive act. `active_at(from, to, v)` for any `v` below the
closing version answers exactly as it did before the close. Every pack
pinned below it is untouched.

Reopening one is retroactive, and that is what broke `78a8714f`. So
the treatment is a monotonicity rule rather than a history:
`valid_to_version` may go from null to a version once, and a `BEFORE
UPDATE` trigger now rejects any other change with
`VALIDITY_WINDOW_CLOSED`. Windows close once.

That leaves `feature_label_ids` as the single remaining hole, which is
the one that was actually written down (A17). Two of the three
exceptions to determinism were undocumented, and it is not a
coincidence that the three holes are exactly the three columns INV-7
whitelists: a column that may be rewritten after approval and is read
by selection is the definition of one.

### Investigated, not fixed: why the v9 repair was an edit

Commit `f6453cc` fixed `transitionObject` closing validity windows for
any status in a flat terminal set, which hid every rejected Hypothesis
from every pack. The fix corrected the code. It could not correct
HYP-0200, whose window had already been closed at v8 by the buggy
path.

The domain offers one correction primitive: a new object superseding
the old one, in the same transaction. Using it here would have created
HYP-0201 superseding HYP-0200, asserting that the hypothesis had been
revised. Nothing about the hypothesis had been revised — Engram's
bookkeeping had been wrong. Supersession would have written a false
statement about the knowledge into permanent history in order to
protect the append-only property of a column.

There is no third option in the model. The engine has no primitive for
"this row's state was produced by a defect and is not what the curator
asserted", so a bookkeeping bug forces a choice between lying about
the knowledge and violating rule 1. The repair chose the second, named
itself `transition.rejected.reopen_window` so it would be visible, and
retroactively changed what the graph at v6 and v8 contained.

Two things made it possible. `valid_to_version` is on the INV-7
whitelist, so the database permitted it — the whitelist exists to let
windows *close*, and nothing distinguished that from reopening. And no
code path reopens a window, so this was a hand-run statement inside a
curation transaction. The new monotonicity trigger closes the first;
the missing primitive is unresolved and is a real gap, not an
implementation detail.

### Investigated, not fixed: the unreported A17 limitation

MTS 3.4.1 says historical reproduction "must report the accepted v1
limitation", and A17 records it as a reproduction limitation.
`reproduceContextPack` never reports it. It returns the pack on
success with no diagnostic, and names the relabelling only when a
relabel happens to break the hash.

The silent-success case is the one that matters. Reproducing a
feature-filtered pack reads the objects' *current* label sets, so a
successful reproduction of such a pack is not evidence that the
selection is what it was — it is evidence that nothing has been
relabelled *yet*. An unfiltered pack is unaffected, because labels
change nothing about its selection. So the report the specs ask for is
narrow and cheap: a pack whose recipe carries feature labels should
carry the caveat on success as well as on failure.
