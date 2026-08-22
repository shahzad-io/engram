# Backfill quick reference

This is the one-page field matrix for hand-authored backfill object files.
The nine rows backed by `knowledge_objects` are taken from the `CASE` branches
in `migrations/003_knowledge_objects.sql` (`knowledge_objects_status_for_type`
and `knowledge_objects_attribute_keys`) and the matching subsections of
Domain Spec §4. External Reference is included separately because Domain Spec
§4.10 explicitly excludes it from `knowledge_objects`; it is a relation target,
not an object accepted by `pke backfill new`.

`[003]` means the migration's database CHECK constraint. `[DS 4.x]` means the
matching Domain Spec §4 subsection. `[004]` is used only for External
Reference's separate table. The examples are minimal object-document JSON:
the importer supplies database envelope fields such as `authored_by`,
approval timestamps, and graph version. A live-captured Decision still needs
a legal `derives_from` relation. In A-BF-1 backfill mode, a historical
Decision may instead use `attributes.origin = "unrecoverable"`. A
non-axiomatic Constraint needs a Decision parent.

For the nine Knowledge Objects, every example also uses the common document
keys `id`, `type`, `scope_id`, `title`, `body`, `status`, and `attributes`
from migration 003's lines 45–61; `feature_labels` is optional and defaults
to an empty array [003:57]. Type-specific fields are the fields listed in the
table.

| Entity type | Required attributes | Optional attributes | Valid initial status | Minimal valid JSON example |
|---|---|---|---|---|
| `requirement` (`REQ-`) | `source` [003:122; DS 4.1] · `rationale` [003:122; DS 4.1] | None [DS 4.1] | `active` [003:91; DS 4.1 lifecycle] | `{"id":"REQ-0001","type":"requirement","scope_id":"global","title":"Requirement","body":"The system records the requirement.","status":"active","attributes":{"source":"founder","rationale":"It must be traceable."}}` |
| `discussion` (`DSC-`) | `medium` [003:123; DS 4.2] · `occurred_at` [003:123; DS 4.2] · `content_ref` [003:123; DS 4.2 pointer] | `participants` [DS 4.2] | `recorded` [003:92; DS 4.2 lifecycle] | `{"id":"DSC-0001","type":"discussion","scope_id":"global","title":"Discussion","body":"Exploratory record.","status":"recorded","attributes":{"medium":"chat","occurred_at":"2026-08-20T00:00:00Z","content_ref":"transcript-0001"}}` |
| `observation` (`OBS-`) | `observed_at` [003:124; DS 4.3] · `evidence_ref` [003:124; DS 4.3 / INV-5] · `review_by` [003:124; DS 4.3 / INV-5] | None [DS 4.3] | `observed` [003:94-101; DS 4.3 lifecycle] | `{"id":"OBS-0001","type":"observation","scope_id":"global","title":"Observation","body":"Something was observed.","status":"observed","attributes":{"observed_at":"2026-08-20T00:00:00Z","evidence_ref":"XRF-0001","review_by":"2026-09-19T00:00:00Z"}}` |
| `hypothesis` (`HYP-`) | `what_was_tried` [003:125; DS 4.4] · `why_it_failed` [003:125; DS 4.4] · `evidence_ref` [003:125; DS 4.4] | `would_reconsider_if` [DS 4.4] | `explored` [003:103; DS 4.4 lifecycle]; backfill may use `rejected` [DS A-BF-1] | `{"id":"HYP-0001","type":"hypothesis","scope_id":"global","title":"Hypothesis","body":"A tested approach failed.","status":"explored","attributes":{"what_was_tried":"The tested approach.","why_it_failed":"It failed under load.","evidence_ref":"XRF-0001"}}` |
| `decision` (`DEC-`) | `statement` [003:126; DS 4.5] · `rationale` [003:126; DS 4.5] · `reversibility` [003:126; DS 4.5] · `alternatives_rejected` [003:126; DS 4.5] | `origin` [DS A-BF-1, backfill only]; `review_required` is a common envelope column [DS 4.5] | `active` [003:104; DS 4.5 lifecycle]; backfill may use `superseded` with an in-import successor [DS A-BF-1] | `{"id":"DEC-0001","type":"decision","scope_id":"global","title":"Decision","body":"The agreed outcome.","status":"active","attributes":{"statement":"Use the chosen approach.","rationale":"It preserves the required property.","reversibility":"cheap","alternatives_rejected":[]}}` |
| `open_question` (`OQU-`) | `question` [003:127; DS 4.6] · `blocking` [003:127; DS 4.6] | `owner` [DS 4.6]; `blocked_items[]` is represented by `blocks` relations [DS 4.6] | `open` [003:105; DS 4.6 lifecycle]; backfill may use `resolved` with an in-import resolver [DS A-BF-1] | `{"id":"OQU-0001","type":"open_question","scope_id":"global","title":"Open question","body":"An unresolved question.","status":"open","attributes":{"question":"Which option should be selected?","blocking":false}}` |
| `constraint` (`CON-`) | `rule` [003:128; DS 4.7 / INV-9] · `enforcement` [003:128; DS 4.7] · `axiomatic` [003:128; DS 4.7 / INV-4] | None [DS 4.7] | `active` [003:106; DS 4.7 lifecycle] | `{"id":"CON-0001","type":"constraint","scope_id":"global","title":"Constraint","body":"A rule that always applies.","status":"active","attributes":{"rule":"Keep the rule true.","enforcement":"hard","axiomatic":true}}` |
| `glossary_entry` (`GLO-`) | `term` [003:129; DS 4.8] · `definition` [003:129; DS 4.8 / INV-9] · `axiomatic` [003:129; DS 4.8] | `aliases` [DS 4.8] | `active` [003:107; DS 4.8 lifecycle] | `{"id":"GLO-0001","type":"glossary_entry","scope_id":"global","title":"Glossary term","body":"The project meaning.","status":"active","attributes":{"term":"MIRA","definition":"The validation project.","axiomatic":true}}` |
| `artifact` (`ART-`) | `kind` [003:130; DS 4.9] · `version` [003:130; DS 4.9] · `location` [003:130; DS 4.9] · `content_hash` [003:130; DS 4.9] · `summary` [003:130; DS 4.9 / INV-9] | None [DS 4.9] | `current` [003:108; DS 4.9 lifecycle] | `{"id":"ART-0001","type":"artifact","scope_id":"global","title":"Artifact","body":"Pointer to the authoritative document.","status":"current","attributes":{"kind":"architecture","version":"1","location":"docs/example.md","content_hash":"0000000000000000000000000000000000000000000000000000000000000000","summary":"The approved document pointer."}}` |
| `external_reference` (`XRF-`) | `system`, `identifier` [004:31-39; DS 4.10] | `location`, `symbol`, `last_verified_at` [004:35-37; DS 4.10] | None: no status lifecycle [DS 4.10] | `{"id":"XRF-0001","system":"docs","identifier":"docs/example.md","location":"docs/example.md","symbol":null,"last_verified_at":null}` |

## Regeneration notes

- If `migrations/003_knowledge_objects.sql` changes a type's
  `knowledge_objects_attribute_keys` or `knowledge_objects_status_for_type`
  branch, update that row's `[003:...]` entries, required keys, or initial
  status.
- If Domain Spec §4 changes a type's Fields, optional fields, lifecycle, or
  semantic rule, update the corresponding `[DS 4.x]` entry and example.
- `content_ref` is the storage key enforced by migration 003. Domain Spec §4.2
  calls the same transcript pointer `body_ref`; the quick reference preserves
  the storage key used by backfill files.
- The generated header `// Initial status: ...` is accepted by the backfill
  loader and is documentation for the curator, not a JSON attribute.
