# Backfill import format

The backfill tool accepts a directory of hand-authored JSON documents:

```text
mira/
  scopes.json
  objects/
    DSC-0001.json
    DEC-0001.json
  relations.json
  external-references.json
  labels.json
  friction.json
```

`objects/` is optional. If omitted, object JSON files may live directly in
the directory. `scopes.json`, `relations.json`, `external-references.json`,
`labels.json`, and `friction.json` are manifests, not Knowledge Objects.

The complete MIRA rebuild uses three ordered curation transactions:

1. `scopes.json` seeds the scope tree.
2. Object files, `external-references.json`, and `relations.json` create the
   knowledge and relation graph in importer-only `backfill_mode`.
3. `labels.json` creates the Project label registry and applies its assignments
   in a separate curator transaction. Assignments are filing metadata under
   A17; they are never object content and never part of the object transaction.

Each phase is skipped when its declared state is already present. An unchanged
manifest therefore creates no graph version. A conflicting existing definition
is a validation failure, not an update.

An object document uses storage-shaped attribute names so the dry run checks
the same keys that the database checks:

```json
{
  "id": "DEC-0001",
  "type": "decision",
  "scope_id": "phase-mira-platform-p1",
  "feature_labels": ["magic-links"],
  "title": "Use the existing link issuer",
  "body": "The issuer remains the single source of link creation.",
  "status": "active",
  "attributes": {
    "statement": "Use the existing link issuer",
    "rationale": "It preserves one audit trail.",
    "reversibility": "cheap",
    "alternatives_rejected": []
  }
}
```

Object files may begin with the generated header
`// Initial status: <status>`. The loader ignores that one line; it is a
curator-facing reminder, not a JSON attribute. Use `pke backfill new <type>`
to create this skeleton with every required attribute key present.

The A-BF-1 backfill mode accepts historical terminal states directly:
`hypothesis` may be `rejected`, `decision` may be `superseded` when its
successor is another object in the same import, and `open_question` may be
`resolved` when its resolving Decision is in the same import. Live capture
continues to require each type's normal initial state.

For a historical Decision whose origin cannot be reconstructed, add the
positive marker inside `attributes`:

```json
"origin": "unrecoverable"
```

This marker is backfill-only, replaces rather than supplements a
`derives_from` origin edge, and is rendered visibly in Context Packs. A
Decision with neither the marker nor a legal origin edge remains a validation
failure.

`feature_labels` accepts canonical names, aliases, or existing label ids.
Unknown names become one batch of label candidates across the whole import.
There is currently no field for a curator to declare an unassigned label
concept when `feature_labels` is omitted; this format gap is registered as
open amendment A18. Post-approval filing is permitted by the separate A17
relabelling curation transaction; it does not require superseding the object.
`scope_ids` may be supplied when recording a two-scope gap; such an object is
recorded in the gap register and is not imported. `attempted_homes` belongs on
gap-register entries, not on successfully classified object files.

`relations.json` is either an array or an object containing `relations`:

```json
{
  "relations": [
    {
      "source_id": "DEC-0001",
      "relation": "derives_from",
      "target_id": "DSC-0001",
      "target_kind": "knowledge_object"
    }
  ]
}
```

`external-references.json` is either an array or an object containing
`external_references`. It declares the typed pointers that relations may
target:

```json
{
  "external_references": [
    {
      "id": "XRF-0001",
      "system": "other",
      "identifier": "C9",
      "location": null,
      "symbol": null,
      "last_verified_at": null
    }
  ]
}
```

`scopes.json` contains the complete fixed-tree inputs. The `global` row may be
included even though migrations create the same root; matching definitions are
no-ops:

```json
{
  "scopes": [
    {
      "id": "project_mira",
      "kind": "project",
      "parent_id": "global",
      "name": "MIRA"
    }
  ]
}
```

`labels.json` keeps registry definitions separate from object assignments:

```json
{
  "labels": [
    {
      "id": "FTL-0001",
      "project_scope_id": "project_mira",
      "canonical_name": "magic-link",
      "aliases": []
    }
  ],
  "assignments": [
    {
      "object_id": "DEC-0006",
      "label_ids": ["FTL-0001"]
    }
  ]
}
```

`friction.json` records qualitative curation friction events:

```json
{
  "actions": [
    {
      "action_id": "friction-4",
      "kind": "spec_consultation",
      "description": "Required attributes not discoverable without consulting Domain Spec",
      "abandoned": false
    }
  ]
}
```

Each event records what went wrong (`kind`, `description`) and whether the
curator abandoned the action. There is no timing field: curation friction is
curator judgement, not machine duration (PRD Step 3a).

Run a read-only validation with:

```text
pke backfill --dry-run --report backfill-report.json backfill/mira
```

Omit `--dry-run` to import the valid subset. Any validation failure or
unresolved label candidate blocks the import. Structural near-duplicate pairs
are warnings only; they never block or merge objects. Domain gaps are
non-fatal and remain outside the graph. A complete import uses the three
transactions above, so a first build normally creates three graph versions;
re-running unchanged files creates none.
Imported objects are always human-authored and receive a
`backfill:<source-file>` source marker.
