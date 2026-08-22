---
title: "MIRA Session Ledger — 2026-08-17"
subtitle: "Complete log of findings, decisions, fixes, and open items"
project: "MIRA / EMSA — cpraedcourse (AHCA) launch prep"
status: "Reference log — not a deliverable"
---

# MIRA Session Ledger — 2026-08-17

A complete, referenceable record of everything worked on today. Organized by workstream, with what was **found**, what was **decided**, what was **done/committed**, and what remains **open**. Read the section headers to jump to a topic.

> **Working method (unchanged):** Claude = architecture/spec/decisions; Claude Code (CC) = implementation via gated investigate → propose → approve → implement. User controls all commits. Verify against reality (live RO DB / code / docs), never assume. CC has LOCAL access only (`local_mira_dev`, the repo); it cannot reach `mira_dev` / servers / AWS — the user runs those.

> **Key environment facts:**
> - `mira.learntastic.com` (live staging) currently points at **`mira_dev`** on the `dev-aurora-all-brands` cluster. **No dedicated staging server yet** — it is provisioned when CRM/Phase 2 work begins. Staging + dev share `mira_dev` for now.
> - `local_mira_dev` = the user's LOCAL clone of `mira_dev`, pointed in the repo `.env`. CC works against this.
> - Source of truth = `learntastic_ro` (LMS read replica, database `lms`).
> - **`learntastic_ro` runs in `US/Central`** (discovered today — see §7). The LMS Linux OS is UTC, but the MySQL DB session/global TZ is US/Central (UTC−5). This matters for every date-window query.

---

## Table of contents

1. Org-link backfill command — built, dress-rehearsed, ready for staging
2. Org/contact data foundation — comprehensive validation (CLOSED)
3. Orphans — permanent (Vishal-confirmed); reconciliation posture; team list
4. Event system — parked (Phase 3/4); seeder decision; workflow-builder context
5. Orphan send-config switch — exact location & flip
6. SES provider default bug — data fix + code fix (major find)
7. Magic-link revert (lts.gs → per-brand) — shape, per-brand mapping, builder change
8. Pipedrive reconciliation (Aug 14, cpraedcourse) — the big investigation
9. `course_status` boundary — the root-cause finding (unpaid + noquiz)
10. Timezone finding (US/Central) — reconciliation + production implication
11. Branch protection (GitHub main) — workflow change
12. Sameer message — staging/sandbox status
13. Consolidated open items / next steps

---

## 1. Org-link backfill command — built, dress-rehearsed, ready for staging

**Command:** `emsa:contacts:backfill-org-links`
Files: `app/Console/Commands/Emsa/BackfillContactOrganisationLinksCommand.php`, `app/Services/Pipeline/BulkImport/OrganisationLinkBackfillService.php`, `app/Data/Pipeline/OrganisationLinkBackfillChunkResult.php`.

**What it does:** orgs-first (`OrganisationSyncService::ingestAll()`), then reads only upstream `users WHERE organ_id > 0` (~557K subset, not 3.2M), in-memory keyset cursor (no watermark, one-shot idempotent), batched grouped `UPDATE contacts SET organisation_id WHERE organisation_id IS NULL AND upstream_contact_id IN (...)`. Non-destructive, env-agnostic. **Also the prod tool** (prod has the same null-org state).

**Dress rehearsal on local clone caught 2 real bugs:**
1. **Missing 4 pending migrations** — command crashed on `Unknown column 'upstream_payload_hash'`. Staging has the same 4 additive migrations pending. **Must `migrate --force` FIRST** or it crashes.
2. **`updated_at` silently bumped on 552K rows** — Eloquent `Builder::update()` auto-touches `updated_at`. Would have shown 552K contacts as "recently updated" in the CRM for no reason, and corrupted anything keyed on `updated_at`. **Fixed** with `Contact::withoutTimestamps(...)`. The unit test had a **false positive** (captured `$originalUpdatedAt` and ran within the same wall-clock second, so timestamps coincidentally matched even with the bug). Hardened the test (backdated fixture to 5 days). Re-verified on real data (reset 3 contacts to 2020-01-01, re-ran, timestamps stayed 2020-01-01).

**Full local run:** 40,985 orgs ingested; 551,449 linked (551,942 with the small batch); ~221s (~2,500 rows/s → staging ~4-6 min); 197 orphans; idempotent; field-isolation proven on 486,360 real rows.

**EXACT staging sequence (to run on Forge host against `mira_dev`):**
1. Pre-flight tinker: confirm `contacts_with_org ≈ 0`, `organisations ≈ 0`.
2. `migrate:status` then `migrate --force` (the 4 additive migrations — REQUIRED).
3. `backfill-org-links --chunk-size=5000 --yes` (~4-6 min).
4. Post: confirm `contacts_with_org ≈ 552K`, `organisations ≈ 41K`.
5. Optional idempotency re-run.

**STATUS:** command committed. **Deploy the `updated_at` fix + command to staging BEFORE running** (run the fixed code, not the buggy version). The org-backfill on `mira_dev` itself is still **OPEN** (CC fixed only the local clone; `mira_dev` contacts still null-org).

---

## 2. Org/contact data foundation — comprehensive validation (CLOSED)

Ran a full read-only validation of the post-backfill data (on `staging_mira`, a clone of post-backfill staging) against `learntastic_ro`.

**Verdict: foundation CORRECT and sound to build on. Closed.**

- **Aggregate integrity:** 0 duplicate orgs, 0 dangling FKs, 0 null names. Corporate (552,539) + individual (2,712,077) = total (3,264,616), no leakage.
- **Org-count parity EXACT:** 41,002 local = 41,002 RO, per brand, to the row.
- **Per-brand proportions match RO** — all 8 brands, gaps ≤0.45% (staleness only, not classification).
- **Row-level correctness proven** — 3,000-row automated semantic audit + hand samples per brand. Each corporate link points to the org whose `upstream_organ_id` matches the contact's RO `organ_id`.
- **Edge cases:** self-referential owners linked correctly; cross-brand linkage 6.9% (by design, correct); `updated_at` NOT bumped (proven on 486,360 rows).
- **Live-event catch:** the 3,000-row audit found 41 "mismatches" (1.37%), 100% traced to one real in-flight upstream org-merge ("Utility Partners of America," ~7,382 rows reassigned org 1138122→943452 minutes before, self-healing on next poll) + 1 test-account drift. **The validation correctly distinguished live staleness from corruption.**

**Framing (settled):** LMS is source of truth; MIRA faithfully mirrors it; send from what's there. Orphans/in-flight-merges are LMS states MIRA correctly reflects.

**Correction captured:** the earlier "PALS ~2.33% orphan" figure did **not** reproduce under rigorous measurement — the correct value is **0.41%** (verified 3 independent ways). Trust 0.41%. (The 2.33% came from a looser/naive-definition earlier pass.)

**Orphan total:** 33 (all individually verified — 30 broken upstream refs, 3 role-changed). Earlier "135" was a less-rigorous/looser count.

---

## 3. Orphans — permanent (Vishal-confirmed); reconciliation posture; team list

**Vishal confirmed:** LMS organizations are **never backfilled/updated once added.** An org that doesn't exist now will never be created later to resolve an orphan. **Therefore orphans are PERMANENT.**

**Consequences:**
- The recurring `backfill-org-links` reconciliation is **NOT needed** for the "orphan gets filled" case — because that case doesn't happen. `backfill-org-links` stays a **one-time / backup tool**, not a scheduled job.
- CC code-trace confirmed: normal sync (`UserSyncPoller`, `UpdatedAtWatermarkPoller`) does **not** auto-relink a resolved-orphan, because the contact's own row doesn't change when an org is created elsewhere — the watermark never re-fetches it. Only `backfill-org-links` (unwatermarked, `WHERE organisation_id IS NULL`) reconciles. But since orphans are permanent, this is moot.
- **Optional insurance:** user may still schedule `backfill-org-links` every 24h as cheap, self-documenting insurance (the `linked` count would reveal if the "permanent" assumption is ever wrong). Not required.

**Orphans → individual:** confirmed correct treatment. The config switch already exists (see §5). Team will review the orphan list; whatever they decide is a config flip.

**Team orphan list:** to be produced RO-grounded (upstream user id + `organ_id` broken ref + brand + email + category), since the team looks up records in LMS terms and local `contacts` doesn't even store `organ_id`. (Shared with Vishal.)

---

## 4. Event system — parked (Phase 3/4); seeder decision; workflow-builder context

**What it is:** `UserLogsPoller` ingests LMS `user_logs` (login, add_to_cart, quiz_fail…) into `event_log` via `PersistEventLogJob`. This is the **write-side foundation** for the Phase 3/4 automation-triggers + workflow-builder system. Read-side is dormant (`EventDispatcher::dispatch()` is an empty Phase-4 stub).

**Findings:**
- **Why it ran unseeded:** dispatch is unconditional; `PersistEventLogJob` dispatches regardless of whether `EventDefinition` rows are seeded. Missing definitions → harmless logged no-op inside the job. So ingestion runs without the seeder.
- **The 100K backlog:** the Forge **scheduler** was queuing `PersistEventLogJob`s into Redis every minute while **Horizon was OFF** (nothing draining). Redis persists queued jobs. When Horizon started, it drained the accumulated pile (100K → 30K in minutes). Scheduler creates jobs; Horizon processes them — separate concerns.
- **Queue contention:** event jobs (`PersistEventLogJob`, `RunPollerJob`) share the **`pollers`** queue with the reminder lane (`RunReminderConsumerJob`). Webhooks are on a **separate `webhooks`** queue (isolated — never blocked by the event backlog). So event backlog can delay reminders, NOT webhooks.
- **Docs phase-inconsistency explained:** docs variously label the event/trigger system Phase 1/3/4. Reason: **Ned pulled "start sending" forward as Phase 0.5**, ahead of the original CRM/events/automation phasing. All docs agree it is NOT Phase 0.5. The seeder's ~9 events are a foundational raw-signal subset of the ~50-trigger catalogue (41 usable / 9 not present per an earlier gap analysis).
- **Workflow builder** = Pipedrive/HubSpot-style visual automation (trigger event → steps: email/SMS/wait/condition/branch). Screenshot showed CRM "Coming in Phase 2," Insights "Coming in Phase 4." Events (seeder) feed the trigger dropdown; triggers/workflows are built on top. All Phase 3/4.

**DECISION:**
- **Do NOT seed** the event definitions — nothing consumes them until Phase 3/4. Seed when the consumers ship.
- **Park event ingestion:** set `PollerRegistry::transactional()` → `return [ //UserLogsPoller::class ]` (commented breadcrumb + accurate comment referencing Phase 3/4 + Ned's Phase-0.5-injection).
- Confirmed safe: `transactional()` contains ONLY `UserLogsPoller`. Reminders are scheduled separately (`Schedule::job(new RunReminderConsumerJob)`, hourly, NOT via registry). Contact/org sync (`UserSyncPoller`) is under `marketing()` (15-min, different loop). Nothing launch-critical reads `event_log`.
- Fix the stale `// TEMP: disabled for user-sync poller testing` comment in `routes/console.php` (it was the user's own toggle, later uncommented — but the comment is now misleading).
- Update `PollerInfrastructureTest` to assert the **parked** state (UserLogsPoller NOT scheduled), not delete the test — it becomes a guard against accidental re-enable.

**STATUS:** decisions made; the `transactional()` edit + comment fix + test update are the pending action.

---

## 5. Orphan send-config switch — exact location & flip

**Location:** `config/reminders.php` lines 166-168. Both env-backed (currently unset → running on defaults).

```php
'orphan_audience'     => env('REMINDERS_ORPHAN_AUDIENCE', 'corporate'),
'orphan_send_enabled' => (bool) env('REMINDERS_ORPHAN_SEND_ENABLED', false),
```

| Want | Env var | Change to |
|---|---|---|
| Orphans **send** (currently suppressed) | `REMINDERS_ORPHAN_SEND_ENABLED` | `true` |
| Orphans treated **individual** (currently corporate) | `REMINDERS_ORPHAN_AUDIENCE` | `individual` |

**Mechanics:**
- `OrphanSendGate::suppresses()` reads `orphan_send_enabled` (send/no-send).
- `ReminderEmailRenderer::orphanAudience()` reads `orphan_audience` (individual vs corporate copy).
- **Provably orphan-only:** Corporate and Individual arms are hardcoded in the `match`; config is read ONLY in the Orphan arm. Test-asserted (`ReminderOrphanConfigAndFullPathTest`) that flipping these dials cannot affect real corporate/individual.
- Env-backed → change in `.env`/Forge + `config:cache`. No deploy.

**Confirmed independent:** can flip send without changing audience, or vice versa. To "send orphans as individual" set both. Currently ~0 orphan candidates are actually due, so flipping affects essentially nothing today — it just sets the policy for future orphans.

**STATUS:** documented; flip when the team decides (post-orphan-list review). Leave on safe defaults (suppressed) until then.

---

## 6. SES provider default bug — data fix + code fix (MAJOR FIND)

**Symptom:** staging sent 2,000+ emails, ZERO open/delivery/bounce events recorded.

**Root cause:** sender identities defaulted to `provider = 'smtp'` → generic `SmtpProvider` → does NOT attach `X-SES-CONFIGURATION-SET` or `X-SES-MESSAGE-TAGS: send_log_ulid`. So SES never emits open/delivery/bounce events → nothing reaches SNS/webhook → **zero tracking AND zero bounce/complaint suppression fleet-wide** (a deliverability risk, not just missing metrics). The correct provider is `ses` → `SesSmtpProvider` (same SMTP creds `email-smtp.us-east-1.amazonaws.com:2587`, just adds the SES headers — no separate AWS SDK creds needed).

**Scope:** 7 of 8 active email identities were on `smtp` with SES hosts (all brands except cpraedcourse). So tracking + bounce handling was dead for 7 brands.

**The `smtp` default was baked into 4 places:** `SenderIdentitiesController` create path, DB column default, `SenderIdentityFactory`, dev seeder. Admin update path did not expose `provider`.

**FIXES:**
- **Data (local `local_mira_dev`):** all 8 identities confirmed `ses` (7 flipped + cpraedcourse already ses).
- **Data (`mira_dev` / staging):** the 7 identities WERE flipped to `ses` on `mira_dev` via tinker on the Forge host (validated each first: SES host, complete creds, config-set present; transactional; provider-only). Result: 8/8 ses on `mira_dev`. *(Note: the earlier `smtp_host` column error was because that column name was wrong — the real flip used the correct schema.)*
- **Code (Part 2):** default → `ses` in create path + `SenderIdentityFactory` + `DevDataSeeder` + a new forward migration `2026_08_12_221107_set_sender_identity_provider_default_to_ses.php` (historical migration NOT modified). Update path **preserves** existing provider (doesn't reset to smtp). Added validation **rejecting** `provider=smtp` when SMTP host matches `email-smtp.*.amazonaws.com` (catches the mismatch). Provider stays create-only (not an editable form field). 59 provider tests + full suite green, PHPStan L6, Pint clean.
- **Chosen approach: Option A (default `ses`)**, not derive-from-host — provider is an explicit field, and deriving from host hides transport behavior in credential parsing (fragile for proxies/alt endpoints).

**Proven working:** a cpraedcourse SES send flowed through to the webhook end-to-end (see §6a).

**STILL OPEN (AWS side):** the SES config-set → SNS **event destinations** must be wired per brand in AWS for SES to actually *emit* events. The provider flip makes MIRA *attach* the config-set; the AWS destination makes SES *emit*. cpraedcourse is proven wired. The other 7 config-sets (`cprcare`, `learntasticc` [shared LT/HIPAA], `aclsnow`, `childcarestraining`, `nationalsafetyinstitutes`, `palscertificationtraining`) need `aws sesv2 get-configuration-set-event-destinations` confirmation.

### 6a. Webhook / SNS event path — confirmed working

- Webhook intake accepted a test event (`{"event_id":"evt_reset_test_001","duplicate":false}`). **Note:** a raw `aws sns publish` of a non-SES message correctly returns 200 but does NOT persist (it's not a real SES event) — that's correct behavior, not a bug.
- CloudShell proved SNS delivered to the webhook: `destination: https://mira.learntastic.com/webhooks/provider`, `statusCode: 200`, `status: SUCCESS`.
- **Path (code-confirmed):** SES (`SesSmtpProvider` attaches config-set + `send_log_ulid`) → SNS → `POST /webhooks/provider` → `ProviderEventWebhookController` (verifies SNS sig, confirms subscriptions) → `ProcessProviderEventJob` (webhooks queue) → `ProviderEventHandler` → writes `send_logs` (open_count/first_open_at/status) + `send_log_events` (open/click/delivered/bounce/complaint) + `processed_provider_events` (idempotency) + suppression on bounce/complaint.
- User has a permanent cloudflared tunnel `https://sns.agenticgraph.dev/webhooks/provider` subscribed to the cpraedcourse SNS topic for local capture.
- **`webhook_events` intake table + `send_log_events` are the persistence targets.** Application-side pipeline is fully built; AWS-side event destinations are the remaining wiring.

---

## 7. Magic-link revert (lts.gs → per-brand) — shape, per-brand mapping, builder change

**Context:** the team is reverting magic links from `lts.gs` shortlinks back to per-brand scoped links. Reason: `lts.gs` routes attribution through a LearnTastic-owned shortener domain → for AHCA-family brands, click/revenue attribution should stay on the brand's own domain (legitimate revenue concern — revenue goes to LearnTastic otherwise).

**Confirmed link shape:** email magic link = `https://{host}/e/{short_link}`.
- Token = `users.short_link` (per-user, DR-3: build from the specific user row, never a bare `short_link` lookup — cross-brand collisions, no unique index).
- **Same URL for corporate AND individual** (Rakesh-confirmed). Audience is determined by `organ_id`, NOT the link. Audience changes template/coupon, not the host.
- Built by **polling `learntastic_ro`** (short_link + web_source come from the RO join in the detector) and sent via **MIRA's own engine** (ADR-001: EMSA originates). NOT lt-admin sending.

**Per-brand host mapping (data-confirmed):**

| Brand | Host | Family | Notes |
|---|---|---|---|
| learntastic | `lts.gs` | lts.gs | LMS-family |
| hipaauniversity | `lts.gs` | lts.gs | LMS-family |
| nationalsafetyinstitute | `lts.gs` | lts.gs | No real users (Rakesh) |
| **childcaretraining** | **`childcaretraining.com` OR `lts.gs`** | **PENDING RAKESH** | Data shows ONLY `childcaretraining.com` (bare host); **`app.childcaretraining.com` does NOT exist** — do not use it. Currently routed to `lts.gs` in the builder. |
| cpraedcourse | `app.cpraedcourse.com` | app | |
| cprcare | `app.cprcare.com` | app | corporate `lms.cprcare.com` users still get `app.cprcare.com` (host doesn't encode audience) |
| aclsnow | `app.aclsnow.com` | app | |
| palscertification | `app.palscertification.com` | app | |
| cprcourseonline | — | EXCLUDED | Product decision (Rakesh): excluded from MIRA brands entirely (`emsa.php` `excluded_brand_keys`). Do not add. |
| learntasticca | — | EXCLUDED | Same exclusion. |

**Current builder:** `MagicLinkUrlBuilder` (`EMAIL_DOMAIN_BY_WEB_SOURCE` constant + `resolveDomainThroughBrand`). Every entry currently maps to `lts.gs`. Keyed on **raw web_source first**, brand only on fallback. The revert requires re-keying to **canonical brand_key** (resolve to Brand first, look up by `Brand::key`) so all subdomains route consistently.

**Empty short_link:** the builder throws `MissingMagicLinkShortLinkException` on empty. One user found (`vishal@gmail.com`, noquiz/learntastic, `short_link = NULL`). `ReminderConsumer` catches per-candidate throwables (logs, increments `failed`, continues) — so it does NOT crash the batch, but the user becomes a "failed" candidate. **Recommendation:** filter empty/blank `short_link` at the detector level (`u.short_link IS NOT NULL AND TRIM(u.short_link) <> ''`) so these users are cleanly excluded, not counted as due/failed.

**Validation matrix (79 links, all brands × types × audience):** built and programmatically verified — every link correct host per brand, correct structure, per-user token, cprcare-corporate dual variants correct, same URL both audiences. **Links validated as working by the user.**
- Coverage flags: 2 missing tokens (the vishal@ user); `cprcourseonline`/`learntasticca` absent from brands table (excluded, expected); no real `lms.cprcare.com` corporate candidate in the snapshot (so app-vs-lms not fully test-settled from data, but Rakesh confirmed same URL).

**STATUS:** shape + mapping confirmed. **Pending:** Rakesh confirms childcaretraining host. Then the builder change (re-key to brand_key, per-brand host map, + detector-level empty-short_link filter) is ready to implement.

---

## 8. Pipedrive reconciliation (Aug 14, cpraedcourse) — the big investigation

**Goal:** confirm MIRA would send the same as Pipedrive for cpraedcourse Individual before cutover.

**Pipedrive baseline (Aug 14, EMAILS sent — Rakesh confirmed these are emails, and audience is truly individual-only):**
noquiz 63 · unpaid 163 · expiring 2,939 · expired 2,083 · **total 5,248**.

**What is CONFIRMED CORRECT on MIRA's side:**
- **Cadences all match Rakesh's lists exactly**, including failed:
  - unpaid: hour_2, day_2, day_3, day_4, day_6, day_14, day_20, day_30, day_60
  - failed: hour_1, day_1, day_2
  - noquiz: hour_2, day_2, day_3, day_4, day_5, day_7, day_14, day_20
  - expiring: day_60, day_30, day_15, day_7, day_3, day_1
  - expired: day_1, day_2, day_5, day_7, day_15, day_30
  - **Cadence is NOT dropping emails.**
- **Audience classification is CORRECT** — of the 25 pending cpraedcourse users, 23 resolve DIRECTLY to real active upstream organizations (Hilton, Jabil, Catalent, county schools, etc.), 2 are individual, 0 orphan. **MIRA is NOT over-classifying individuals as corporate.** The corporate/individual foundation holds. Pipedrive's population differs; MIRA's classification is accurate.

**Interpretation errors WE made and corrected (verified, both small):**
1. **Unit:** originally compared Pipedrive EMAILS vs MIRA USERS. Corrected to emails-to-emails.
2. **Timezone:** the population count used UTC Aug 14; the DB is US/Central. Corrected Central figures: expiring broad **798 → 781** (−17, −2.1%); detector-qualified **766 → 751**; queueable after per-user cap ≤ **742**. (Direction/cadence math confirmed correct — `dueAt = expiration_date − N days`; one certificate matches only one milestone per day.)

**The decisive finding:** **Pipedrive's count EXCEEDS the entire live source.** For expiring, the complete live source (before any MIRA predicate) is ~798 (UTC) / ~781 (Central) certificate rows. Pipedrive reports 2,939. **You cannot generate 2,939 one-per-certificate emails from ~781 certificates.** MIRA detects ~751-766 of the ~781-798 available (removing only ~15-32 for legitimate reasons — voided, renewals). So:
- MIRA is detecting the **near-complete eligible population.**
- Pipedrive's 2,939 is a **different KIND of count** — almost certainly retries/re-executions ("Done Executions" ≠ unique recipients), a wider date window, or a denser cadence. **This cannot be resolved from MIRA's data.**

**Strict same-day (Central Aug 14) comparison:** Pipedrive 5,248 vs MIRA 1,359 gated / 1,636 raw. Per type:
- noquiz 63 vs 6 (real shortfall — but see §9, definition too narrow)
- unpaid 163 vs 0 (guard bug — see §9)
- expiring 2,939 vs 766 (Pipedrive exceeds the entire source)
- expired 2,083 vs 864 (partly cutover artifact: day_15/day_30 excluded by Aug-7 cutover, restores 277; self-resolves in production)

**Cutover artifact:** the Aug-7 cutover (`expiration_date ≥ cutover`) truncates expired day_15/day_30 buckets in the clone (a clone/recency artifact, self-resolves in production when the cutover is old). Expiring's Aug-14 count is unaffected (all Aug-14 executions are after Aug 7).

**BLOCKED ON:** Pipedrive recipient-level export (message drafted for Rakesh). The single most useful number: **unique recipients** for expiring. If ~750, MIRA matches and the gap is retries; if genuinely ~2,939 distinct people, a real population difference exists. Given the source only holds ~781, unique recipients ≈ MIRA is the strong expectation.

**Meta-lesson:** the reconciliation's grand total nearly matched (−134) by coincidence — it masked four large offsetting divergences (expiring +1,258, expired −1,174, unpaid −163, noquiz −55). Never trust a matching total without the per-type breakdown.

---

## 9. `course_status` boundary — the root-cause finding (unpaid + noquiz)

**This is the most structurally important finding of the day.** The noquiz and unpaid detectors both read the SAME overloaded `sales.course_status` field, and both mishandle it.

**Core finding:** `course_status` is NOT a mutually-exclusive payment-and-progress partition. It cannot be used to infer payment, and `Not Started` alone cannot infer "no quiz attempt."

**Evidence (cpraedcourse):**
- **`Not Paid` is effectively unused** — only 3 rows. Yet the unpaid detector keys its "paid" proxy off `course_status != 'Not Paid'`. So it treats `Not Started`, `In Progress`, `Passed` all as "paid."
- **The same status appears on both paid and unpaid orders:** `Not Started` = 9,958 pending + 40,441 paid; `Passed` = 863 pending (593 genuinely unpaid: positive balance, null paid_date) + 1.7M paid. **So `course_status` cannot tell you payment state.**
- **Users occupy multiple states** (16,064 in the 90-day Individual cohort) because they own multiple enrollments. **Classification must be per enrollment, then deduped per user/day — never one status per user.**

**Unpaid bug (confirmed, found in two sessions):** `UnpaidReminderDetector` uses `course_status != 'Not Paid'` as payment proof. `PASSED_UNPAID` (Pipedrive) targets `Passed` course + genuinely unpaid ORDER — exactly the population MIRA excludes (because `Passed != 'Not Paid'` → treated as paid). Also wrongly excludes `Not Started`/`In Progress`/`Failed` unpaid users. **Fix: use real order payment state (`orders.status`, `balance`, `paid_date`, void), NOT `course_status`.** *(Confirm the exact authoritative "paid" predicate with the devs / LMS payment lifecycle before implementing — don't swap one proxy for another.)*
- **But even corrected, Aug-14 Individual = 2 users** (Passed + genuinely unpaid), neither with a cadence due on Central Aug 14. So the guard fix does NOT reconcile to Pipedrive's 163 — that population mismatch is separate and needs Pipedrive data.

**Noquiz bug:** MIRA uses `course_status = 'Not Started'` (Aug-14: 6 rows). Pipedrive's "registered but didn't take the quiz" can include `In Progress` learners who never attempted the quiz. Found 1,013 additional `In Progress`-no-quiz-evidence rows (862 users). **`Not Started` is sufficient but NOT necessary.** Correct definition: **paid + quiz-capable enrollment + no quiz-attempt evidence** (checking `default_quiz_attempt` + quiz_start/quiz_fail/quiz_pass events).
- **But** including all 1,013 → ~1,019 candidates, far above Pipedrive's 63. So Pipedrive has an additional eligibility rule (course capability? window?) landing it at 63 — needs recipient-level validation to calibrate. Don't overshoot.

**The correct 6-layer decision boundary (the design deliverable):**
1. **Payment** — from `orders` (status/balance/paid_date/void), never `course_status`. Unpaid order → unpaid branch; paid → progress branch.
2. **Quiz eligibility** — do NOT run noquiz for products/brands without a quiz (capability gate).
3. **Quiz evidence** — `default_quiz_attempt` + quiz events. No attempt → noquiz; failed latest → failed.
4. **Progress** — `course_status` as a SECONDARY signal only (informs copy, never proves payment).
5. **Completion** — Passed + paid = done; Passed + unpaid = PASSED_UNPAID.
6. **Identity** — classify per sale/order/course, then dedupe per user/day.

**Brand-inconsistency (a real launch risk):** brands populate `course_status` differently — LT uses `Not Paid` (2,502 rows), HIPAA (190), NSI (57); cpraedcourse (3, unused); aclsnow/pals (zero). **MIRA applies ONE global interpretation with no brand/capability gating.** Also: the noquiz detector scans EVERY active brand host, including LT/HIPAA/NSI which have no applicable quiz sequence — so MIRA may generate noquiz reminders for quiz-less brands.

**Thread separation (important):**
- **Thread 1 — Pipedrive count reconciliation:** BLOCKED on recipient-level export. The corrected model does NOT match Pipedrive (unpaid 2 vs 163, noquiz ~1,019 vs 63). Don't change MIRA to *match* Pipedrive until their data explains their population.
- **Thread 2 — MIRA detector correctness (independent, real):**
  - Unpaid guard fix (use `orders` payment state) — CLEAR, do it (confirm predicate with devs first).
  - Brand/capability gating (don't run noquiz on quiz-less brands; respect per-brand conventions) — CLEAR, do it.
  - Noquiz definition (Not Started → + In Progress-no-quiz) — needs Pipedrive validation to calibrate, or it overshoots to ~1,019.
  - Per-enrollment classification + dedupe per user/day.

---

## 10. Timezone finding (US/Central) — reconciliation + production implication

- **LMS Linux OS = UTC; LMS MySQL DB session/global TZ = `US/Central` (UTC−5).** Confirmed: at the same instant OS showed 20:43 UTC, DB showed 15:43. Verified via `SELECT NOW(), UTC_TIMESTAMP(), @@global.time_zone, @@session.time_zone`.
- **`expiration_date` is a Unix integer** — the DB session TZ does not auto-adjust numeric comparisons; the query must construct the intended day boundary. Central Aug 14 = `2026-08-14 05:00:00` → `2026-08-15 04:59:59` UTC.
- **Reconciliation impact:** small (−2.1% on expiring volume; 798→781). Did NOT explain the Pipedrive gap.
- **PRODUCTION IMPLICATION (real, separate):** MIRA's Laravel app timezone is UTC; cadence timestamps are constructed in UTC. But the LMS data is Central. So **MIRA's detectors compute cadence day-boundaries in UTC against Central data** — reminders fire ~5 hours off from the business (Central) day boundary. Volume effect is small but the *day a reminder fires* can shift. **Worth fixing for production correctness** so reminders fire on the correct (Central) day. (Not the reconciliation gap, but a genuine pre-launch item.)

---

## 11. Branch protection (GitHub main) — workflow change

- `git push origin main` now rejected: `GH006: Protected branch update failed … Changes must be made through a pull request.`
- **Not something the user broke** — someone enabled branch protection on `learntastic-llc/mira-laravel` `main`. Direct pushes are now blocked; changes go through PRs.
- **New workflow:** commit → push to a feature branch → open PR → merge. The gated CC workflow (investigate/approve/implement/commit) is unchanged; only the final push step becomes branch + PR.
- **Confirm with the team:** who enabled it, and whether it requires approvals (self-merge vs reviewer) — determines the exact merge path while the user is the primary shipper.

---

## 12. Sameer message — staging/sandbox status

Drafted and sent: `mira.learntastic.com` is on a STAGING DB (`mira_dev`, not production) and in SANDBOX mode (all emails redirect to a single test address, NOT real contacts). **Sameer keeps sending reset + corporate-invite from his side AND keeps calling the webhook endpoint in parallel.** Do not switch anything off until an explicit go-ahead after production validation. His emails are currently the only ones reaching real users; MIRA's are sandboxed.

---

## 13. Consolidated open items / next steps

**Blocked on team:**
1. **Pipedrive recipient-level export (Rakesh)** — to explain the 2,939 (unique recipients is the key number) and calibrate the noquiz definition. *(Message drafted.)*
2. **Childcaretraining magic-link host (Rakesh)** — `lts.gs` vs `childcaretraining.com` (NOT `app.` — doesn't exist). *(Waiting.)*
3. **Pipedrive "Individual" / noquiz definition (Rakesh)** — does noquiz include In Progress-no-quiz? All brands or quiz-only? *(Part of the export ask.)*
4. **Branch-protection details (team)** — who/what it requires.

**User-run (Forge/`mira_dev`/AWS — CC can't reach):**
5. **Org backfill on `mira_dev`** — run the 5-step sequence (migrate --force FIRST, then `backfill-org-links`, validate ≈552K). `mira_dev` contacts still null-org (only local/clone fixed).
6. **SES code deploy (Part 2)** — deploy via PR/branch, `migrate --force` (the new provider-default migration), `config:cache`, restart Horizon if needed.
7. **AWS SES event destinations** — confirm all 8 config-sets have SNS event destinations wired (only cpraedcourse proven). `aws sesv2 get-configuration-set-event-destinations`.

**Code work (CC, gated):**
8. **Event system park** — `PollerRegistry::transactional()` → `return []`/commented; fix stale `console.php` comment; update `PollerInfrastructureTest` to assert parked state.
9. **Magic-link builder revert** — re-key to brand_key, per-brand host map (§7), + detector-level empty-short_link filter. *(After childcaretraining confirmed.)*
10. **Unpaid guard fix** — use `orders` payment state, not `course_status`. *(Confirm payment predicate with devs first.)*
11. **Brand/capability gating** — don't run noquiz on quiz-less brands; per-brand `course_status` handling.
12. **Noquiz definition fix** — Not Started → paid + quiz-capable + no-quiz-evidence. *(Calibrate against Pipedrive export.)*
13. **Timezone fix (production)** — MIRA detectors should compute cadence in Central, not UTC, so reminders fire on the correct day.
14. **Empty short_link detector filter** — `u.short_link IS NOT NULL AND TRIM(u.short_link) <> ''`.

**Deferred (post-launch):**
15. Phase 2 CRM (deals/leads/org profiles + dedicated staging server).
16. Phase 3/4 automation (event consumers, ~50 triggers, workflow builder, `EventDispatcher` wiring, event seeder).
17. Optionally schedule `backfill-org-links` 24h as orphan-reconciliation insurance (not required — orphans are permanent).

---

## Key meta-lessons (today)

- **Verify units before comparing.** The Pipedrive gap analysis conflated emails-vs-users and UTC-vs-Central — both real errors, both caught, both small. Correcting them *sharpened* the conclusion rather than changing it.
- **A matching grand total can mask offsetting divergences.** −134 total hid ±1,000s per type.
- **A green unit test can lie.** The `updated_at` isolation test passed via a same-second timing coincidence; only real-data-with-old-timestamps exposed the bug.
- **CC has LOCAL access only.** "CC fixed it" ≠ "staging/`mira_dev` fixed." The org-backfill and the first SES flip were both local-only until run against `mira_dev` on the Forge host. Enforce the boundary (CC self-corrected when it tried to reach the server).
- **`course_status` is overloaded** — payment + progress in one field. Using it as a payment proxy is the root of both the unpaid and noquiz bugs. Payment belongs in `orders`; quiz-status in quiz-evidence; progress in `course_status` as secondary only.
- **A source ceiling is a hard bound.** Pipedrive's 2,939 exceeding the ~781 source proves the gap is Pipedrive's counting, not MIRA's detection — no amount of MIRA analysis closes it; only Pipedrive's data does.
- **The naive definition trap persists.** `organ_id > 0` (conflating orphans with corporate) and `course_status != 'Not Paid'` (conflating progress with payment) are the same class of error: a weak proxy standing in for the real signal.