# Analysis V2 E2E Unblock and Launch-Stabilization Design

**Date:** 2026-07-21

## Goal

Restore the authorized Instagram V2 canary path without pausing the live Groble sale, complete one real `0_min._.00` Plus E2E with reconciled cost and durable result evidence, and use that evidence as the input to the already-defined automatic-launch gates.

This design does not turn early-bird payment into automatic fulfillment and does not enable automatic public analysis admission. Those are later launch changes with their own recovery, concurrency, and rollout requirements.

## Reconstructed Session State

The interrupted Claude Code session had already completed and shipped the exact-set profile repair work through PR #79 and dependency PR #80. The three profile-repair migrations are applied remotely, the worker and Vercel deployment were verified, and temporary E2E sharding was torn down after the last failed canary.

Three authorized canary attempts then exposed harness and database-contract problems before a request could enter the repaired worker path:

1. Public production admission took precedence over the signed test admission, so the first attempt could not consume a test entitlement.
2. The headless harness initially polled entitlement only once instead of replaying while the preflight remained `admission_pending`.
3. The corrected harness reached a ready Plus preflight, but request creation returned `ANALYSIS_START_FAILED` and atomically rolled back.

The third failure was reproduced directly against the linked database in a rollback-only transaction using the real production consumer. PostgreSQL returned `23514` on `analysis_requests_plan_type_check`: the legacy column accepts only `basic|standard`, while the V2 catalog and entitlement consumer can select `plus`.

A second rollback-only reproduction explained the recurring retention 500s. `purge_expired_analysis_v2_preflights` selects expired preflights that are still referenced by `earlybird_orders.preflight_id`, whose foreign key uses `ON DELETE RESTRICT`. One such row aborts the whole bounded purge batch with `23503`.

The existing provider-policy PGlite test did not catch the Plus failure because it stubs `consume_analysis_v2_test_entitlement`; it verifies policy binding over a pre-existing request rather than real request creation.

Finally, migration `20260719190000_reconcile_stuck_groble_earlybird_order.sql` is applied remotely but remained untracked in the interrupted checkout. It must be restored unchanged so a fresh clone has the same migration history as production.

## Considered Approaches

### 1. Re-run the canary as Standard

This would avoid the legacy constraint, but it would hide an actual catalog-to-storage mismatch and leave the retention cron broken. It is useful only as a diagnostic, not as the production fix.

### 2. Build a separate staging clone

This would avoid touching production sale admission during the canary, but it would not exercise the real secrets, quotas, provider ledgers, Cloud Tasks, or retention state that caused the failures. It also introduces environment drift immediately before a production launch decision.

### 3. Repair the production contracts and give signed canaries explicit precedence

This is the selected approach. It fixes both reproduced database defects, lets a valid signed canary coexist with public production admission, and keeps invalid signed headers from silently falling through to a production-paid path.

## Design

### 1. Admission selection is request-scoped

The preflight route will distinguish three signed-admission states:

- `absent`: use the deployment's normal public-admission and `PREFLIGHT_ACCESS_MODE` configuration;
- `valid`: require the test-entitlement feature configuration and persist `access_mode = 'test_entitlement'`, even when public admission is enabled;
- `invalid`: reject before persistence and before any provider dispatch.

This removes the need to flip `PREFLIGHT_ACCESS_MODE` or disable the live sale for an operator canary. A random or expired test header never becomes a production request. A request with no test header retains the existing production behavior exactly.

The signed token remains bound to the authenticated user, normalized target, and idempotency key. The route does not log the token or expose verification details.

### 2. Plus is a valid V2 request snapshot

An append-only migration will replace `analysis_requests_plan_type_check` with:

```sql
CHECK (plan_type IN ('basic', 'standard', 'plus'))
```

The legacy column continues to hold the selected V2 plan snapshot, so accepting the complete catalog domain is the smallest coherent fix. The migration will add the replacement as `NOT VALID` and validate it explicitly, preserving forward safety without rewriting existing values.

This does not make Plus purchasable in Groble. Early-bird checkout continues to allow only Basic and Standard, while Plus remains waitlist/deferred. The change only makes the already-authorized test-entitlement Plus selection persistable.

### 3. Order-referenced preflight tombstones are retained

The purge function will keep its existing PII scrub phase. The delete candidate query will additionally exclude any preflight referenced by `earlybird_orders` or `earlybird_waitlist`.

Both tables intentionally use `ON DELETE RESTRICT`; their linked preflights therefore act as durable tombstones. The preflight PII is still scrubbed on expiry, while the order/waitlist keeps the business record it already owns. Unreferenced expired preflights remain deletable, and unreconciled provider-run protections remain unchanged.

Although the observed failure was an order reference, the waitlist has the same restrictive foreign key and must be covered by the same invariant to prevent the next poison row.

### 4. Tests exercise the missing seams

Route tests will cover the full precedence matrix:

| Public admission | Signed header | Result |
|---|---|---|
| enabled | absent | normal production access mode |
| enabled | valid | test-entitlement access mode |
| enabled | invalid | rejected before persistence |
| disabled | valid | test-entitlement access mode |
| disabled | absent/invalid | unavailable/rejected |

A focused PGlite regression will apply the forward migration over a representative pre-migration schema and prove:

- a Plus request insert fails before the migration and succeeds afterward;
- an order- or waitlist-referenced expired preflight is scrubbed but retained;
- an otherwise deletable expired preflight is removed;
- the purge call completes without a foreign-key failure.

A migration contract test will also protect function grants, the Plus domain, both restrictive-reference exclusions, and the absence of destructive `CASCADE` changes.

### 5. Production canary procedure

After review and complete local verification:

1. apply the append-only migration and verify remote definitions read-only;
2. deploy the route change while leaving normal public admission and sale settings unchanged;
3. restore only the reviewed secondary/quinary worker secret references and enable request-bound authorized-test sharding;
4. confirm no active V2 work, current provider quota/headroom, deployed SHA parity, and one active worker revision;
5. mint a fresh admission/entitlement pair with the required paid-call confirmation;
6. execute the corrected polling loop and monitor until terminal;
7. verify result reopen, evidence completeness, job/provider cleanup, and reconciled Apify/Gemini/GCP cost;
8. disable authorized-test sharding and remove temporary worker secret references after no bound request remains.

No Groble payment is made. No public user request is used for the canary. Paid provider calls remain bounded to the explicitly authorized target and entitlement.

## Failure Handling

- Migration or deployment verification failure stops before the paid run.
- An invalid signed header creates no preflight and dispatches no task.
- A provider-start ambiguity is reconciled from the durable ledger; it is never replaced blindly.
- Any new canary failure is reproduced at the narrowest safe boundary, covered by a failing test, fixed, redeployed, and replayed under the existing idempotency contracts.
- Teardown runs on both success and failure, but never while an authorized request still has active jobs or provider runs.

## Launch-Stabilization Continuation

A completed single E2E is evidence, not automatic-launch authorization. After the E2E, work continues against the existing launch plan in this order:

1. implement the deployment-wide fenced Gemini lease capped at eight across revisions;
2. collect controlled Basic and Standard samples for p50/p95 duration and total acquisition cost, including failures;
3. eliminate unknown Gemini usage or adopt an explicitly reviewed conservative pricing policy;
4. design durable paid-order fulfillment with an outbox/lease/replay/recovery contract instead of dispatching work directly from the Groble webhook;
5. resolve issue #71's discounted late-cancel reattribution contract before relying on automated payment recovery;
6. make an explicit admission/rollout decision. Plus remains waitlist-only.

Each item needs its own failing tests and deployment gate. The E2E evidence determines the concrete limits and failure policy; those values must not be guessed in advance.

## Definition of Done for This Implementation Slice

- The applied manual reconciliation migration is tracked unchanged.
- The admission precedence matrix is green and public requests without a signed header are unchanged.
- Plus request creation and retention-reference regressions are green in PGlite.
- The new migration is applied and its remote constraint/function definitions match the reviewed SQL.
- Vercel and Cloud Run run the reviewed SHA with the intended temporary canary policy.
- The authorized Plus E2E reaches `completed`, is reopenable from history, and produces complete sanitized evidence and reconciled cost.
- No active jobs/provider runs/artifacts remain and temporary sharding is removed.
- The automatic-launch gates remain closed and their next implementation plan is updated from measured evidence.
