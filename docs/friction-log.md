# Curation friction log

The entries below record moments where the backfill workflow required avoidable
spec consultation or manual recovery. They are numbered to preserve the
validation log's item numbering.

Friction is **curator judgement**, not machine time. The largest cost is
deciding what type a thing is, what scope it is true at, and consulting the
spec for required attributes. Instrumenting file-write duration would produce a
number that looks meaningful and is not.

## Item 4 — Required attributes were not discoverable

While preparing the fourth backfill item, the curator could not determine the
required attributes without consulting the migration and Domain Spec. The
workflow exposed the schema only after a failure, rather than at the point
where a new object file was started.

Remediation: `pke backfill new <type> [--id ID]` now creates a skeleton under
`backfill/mira/objects/` with every required attribute key present, the
type's initial status, and a generated initial-status comment.

## Item 5 — First real MIRA backfill attempt was blocked by provenance

The first real MIRA backfill attempt involved 20 authored files. It produced
12 recorded gaps in total, imported 0 objects, and exposed three
near-duplicate Decision pairs that had not been detected during authoring.

Actual wall-clock authoring time was not captured and is **not recorded**.
Friction for this item is the provenance block itself, not a duration.

## Item 6 — Friction is qualitative, not timed

The friction report no longer carries a timing field. Curation friction in PRD
Step 3a is assessed by recording what went wrong (kind + description) and
whether work was abandoned — not by summing milliseconds. Timing instrumentation
would measure the wrong thing.

## Item 7 — Feature labels were not discoverable in the import

The first hand-authored attempt is recorded as 20 authored files; it imported
0 objects. The completed A-BF-1 import directory contained 23 object files
and imported 23 objects, but supplied 0 feature labels because no object file
asked for them and the Project registry was empty.

At the time of the import, the requested `magic-link` and `event-lane`
labels could not be assigned after approval: `feature_label_ids` was protected
by INV-7, so doing so would have required superseding each affected object.
That operation was correctly stopped rather than inventing history. A17 now
resolves the filing distinction through a relabelling curation transaction;
whether the format should surface explicit unassigned-label suggestions
alongside label candidates remains open as A18.

## Item 8 — Triage output is raw JSON; one field required reading four objects

On 22 Aug 2026 the curator triaged a four-element Fovea proposal
(`ART-0200`, `DEC-0200`, `HYP-0200`, `CON-0200`) from `pke triage` in a
terminal. The listing is the full nested candidate payloads. Verifying a
single Decision `rationale` field meant reading every object in full: the
rationale lives on the Decision child, the four relations are attached to
the Artifact root, and the Hypothesis exists so that a withdrawn measurement
is not mistaken for that rationale.

Workable for a few objects that matter. Likely not for routine volume.
This is evidence toward OQ-P5 / PRD Step 3a (curation friction measured
during validation; the minimum UI is built only if the measurement demands
it). Not a request to build a UI now.

