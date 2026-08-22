id: DEC-0001
type: Decision
scope: MIRA
title: Poll-based ingestion, EMSA originates all sends
statement: EMSA polls the LMS Aurora read replica (learntastic_ro) for state and originates all sends itself. It does not depend on any push/event pipeline from the LMS.
rationale: The fleet is heterogeneous (Laravel + WordPress brands). A push-relay model requiring a distributable Laravel package could never cover WordPress brands, forcing either N per-stack clients or permanent Brevo dependence for non-Laravel brands.
reversibility: costly
alternatives_rejected:
  - alternative: Push/relay model (MIRA composer package installed per sending brand, pushes rendered email to EMSA /api/v1/send)
    reason: Structurally incapable of covering non-Laravel brands in the fleet
authored_by: human
source_ref: ADR-001, MIRA architecture session ~2026-07
status: active

---

id: DEC-0002
type: Decision
scope: MIRA
title: Reminders are state-based detection, not event-log-based
statement: Reminder detectors read current state directly from the LMS replica (e.g. unpaid = order still pending) rather than relying on an event_log pipeline.
rationale: This is the correct model per ADR-002, explicitly overruling a stale spec assumption that framed state-based detection as drift.
reversibility: costly
alternatives_rejected:
  - alternative: Event-log-driven detection
    reason: Depends on upstream event pipeline reliability EMSA does not control
authored_by: human
source_ref: ADR-002, same session as DEC-0001
status: active

---

id: DEC-0003
type: Decision
scope: MIRA
title: Contacts keyed on users.id, never email
statement: Contact identity uses upstream_id (users.id) as the unique key, expressed as (brand_id, upstream_contact_id). Email is never the identity key.
rationale: Keying on email caused a widespread wrong-login-link bug (the "C9" issue); fixing it required re-importing ~3.23M contacts under the corrected key.
reversibility: one_way
alternatives_rejected: []
authored_by: human
source_ref: MIRA/EMSA architecture session
status: active

---

id: DEC-0004
type: Decision
scope: MIRA
title: Corporate/individual audience resolved via organ_id, not web_source
statement: Audience type (corporate vs individual) is determined by organ_id through OrganisationLinkResolver. web_source is not used as an audience signal.
rationale: The old rule (web_source = lms.cprcare.com -> corporate) was wrong on two fronts: Samir confirmed lms.cprcare.com is a magic-link routing host, not an audience marker, and Rakesh confirmed corporate users exist across all brands (~552K contacts fleet-wide per RO data investigation), not only cprcare.
reversibility: costly
alternatives_rejected:
  - alternative: Keep web_source-based rule
    reason: Factually wrong on both the signal meaning and the brand scope
authored_by: human
source_ref: MIRA/EMSA architecture session, Aug 2026
status: active

---

id: DEC-0005
type: Decision
scope: MIRA
title: Two sending lanes, strict separation
statement: Webhook/transactional lane handles only password_reset_requested and corporate member invite, and never uses magic links. Poll/reminder lane handles all five reminder types (no-quiz, unpaid, failed, expiring, expired) and always uses magic links.
rationale: Keeps critical transactional sends (password reset) architecturally isolated from bulk reminder sends, avoiding shared failure modes.
reversibility: costly
alternatives_rejected: []
authored_by: human
source_ref: MIRA/EMSA architecture session
status: active

---

id: DEC-0006
type: Decision
scope: MIRA
title: Magic links route through shared lts.gs domain
statement: Magic links for all mapped AHCA-family brands use the shared lts.gs/e/{short_link} host and the users.short_link token, not per-brand hosts.
rationale: Corrects Sameer's initial per-brand host table; the shared-domain model is what the team confirmed as accurate after follow-up.
reversibility: cheap
alternatives_rejected:
  - alternative: Per-brand host pattern (app.<brand>/e/...)
    reason: Was Sameer's first answer but superseded by his own correction
authored_by: human
source_ref: EMSA/MIRA magic-link resolution session, 2026-08-13
status: active

---

id: DEC-0007
type: Decision
scope: MIRA
title: Orphan candidates default to suppressed
statement: REMINDERS_ORPHAN_SEND_ENABLED defaults to false, suppressing sends to contacts with no resolvable organisation link. If ever enabled, REMINDERS_ORPHAN_AUDIENCE defaults to corporate.
rationale: Prevents sending reminders to unresolved/ambiguous audience contacts by default; safer failure mode than guessing.
reversibility: cheap
alternatives_rejected: []
authored_by: human
source_ref: EMSA/MIRA magic-link resolution session, 2026-08-13
status: active

---

id: DEC-0008
type: Decision
scope: MIRA
title: cprcourseonline fails loud on unmapped magic link
statement: cprcourseonline is intentionally left unmapped in MagicLinkUrlBuilder and throws UnmappedMagicLinkWebSourceException rather than falling back to a guessed link pattern.
rationale: A wrong guessed login link is worse than a visible failure; explicit exception forces a real mapping decision when the brand goes live.
reversibility: cheap
alternatives_rejected:
  - alternative: Fall back to a default/guessed host pattern
    reason: Risks sending broken login links silently
authored_by: human
source_ref: EMSA/MIRA magic-link resolution session, 2026-08-13
status: active

---

id: DEC-0009
type: Decision
scope: MIRA
title: SES click tracking disabled
statement: Click tracking was disabled from the AWS SES console for MIRA sends.
rationale: SES was rewriting magic links to a tracking subdomain that did not resolve, breaking login links in reminder and transactional emails.
reversibility: cheap
alternatives_rejected: []
authored_by: human
source_ref: MIRA/EMSA magic-link resolution session
status: active

---

id: DEC-0010
type: Decision
scope: MIRA
title: Dedicated EC2 instance, shared Aurora cluster
statement: EMSA runs on its own Forge-managed EC2 instance, separate from ATS and Bidstream, while using the existing shared Aurora cluster.
rationale: Bursty email/SMS queue workers, blocking LLM I/O (ATS), and scraping (Bidstream) have incompatible runtime profiles; co-locating them on shared Apache/mod_php risks worker exhaustion and blast-radius failure across revenue-adjacent systems. Aurora already being provisioned removed the main cost objection to separate compute.
reversibility: costly
alternatives_rejected:
  - alternative: Bump the existing shared server
    reason: Runtime-profile incompatibility and blast-radius risk outweigh the cost savings
authored_by: human
source_ref: Server architecture for scaling Laravel projects session
status: active

---

id: DEC-0011
type: Decision
scope: MIRA
title: Primary-plus-fallback delivery providers
statement: Email/SMS delivery across Twilio, SES, and SendGrid uses a primary-plus-fallback strategy, not round-robin. One unified suppression list applies across all providers, and bounce/complaint webhooks are normalized into a single internal event format.
rationale: Round-robin complicates suppression-list consistency and bounce handling across providers; primary-plus-fallback keeps failure handling simple and auditable.
reversibility: costly
alternatives_rejected:
  - alternative: Round-robin across providers
    reason: Complicates unified suppression and bounce normalization
authored_by: human
source_ref: Server architecture for scaling Laravel projects session
status: active

---

id: DEC-0012
type: Decision
scope: MIRA
title: CRM stays inside MIRA, not split to lt-admin
statement: The CRM module remains part of MIRA rather than being split out into lt-admin.
rationale: Splitting would risk data integrity, create TCPA/CAN-SPAM compliance exposure, run into lt-admin infrastructure limitations, and cost timeline.
reversibility: costly
alternatives_rejected:
  - alternative: Split CRM module into lt-admin
    reason: Compliance and data-integrity risk plus infrastructure limitations
authored_by: human
source_ref: Message to Ned on MIRA CRM/BDR strategy
status: active

---

id: DEC-0013
type: Decision
scope: MIRA
title: Global sandbox toggle, not per-brand
statement: MIRA uses one global sandbox switch (Stage 1-3) that redirects the email envelope recipient to shahzad@learntastic.com while preserving the intended recipient on the record. A richer per-brand sandbox UI was scoped and shelved.
rationale: Per-brand sandbox UI added complexity not justified at this stage of the platform.
reversibility: cheap
alternatives_rejected:
  - alternative: Per-brand rich sandbox UI
    reason: Shelved as unnecessary complexity for current phase
authored_by: human
source_ref: MIRA/EMSA architecture session
status: active