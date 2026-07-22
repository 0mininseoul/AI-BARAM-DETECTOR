# Apify Primary Cutover and Definite Start Rejection Design

## Context

The production Cloud Run service currently resolves logical slot `primary` through
`ai-baram-v2-apify-primary:2`. A secret fingerprint comparison proves that version is the local
`APIFY_SEPTENARY_API_TOKEN`. The same secret's version `1` matches the local
`APIFY_PRIMARY_API_TOKEN`.

The deployed Septenary account has exceeded its monthly usage ceiling. The requested Primary
account is on the Free plan with a $10 monthly ceiling, $5.473343669480983 consumed, and
$4.526656330519017 remaining in the current usage cycle ending 2026-07-25T23:59:59.999Z. The
profile Actor is accessible from that account.

The failed preflight reserved a `primary` provider row before Apify rejected the Actor start. No
Actor run exists in the exact account, Actor, and reservation time window. The row must remain
bound to the old version until the existing 30-minute quiet-period and preflight-expiry gates permit
an owner-only `resolved_no_run` resolution.

## Goals

1. Move new production Analysis V2 and preflight work to `APIFY_PRIMARY_API_TOKEN` without
   changing a numeric secret reference on an existing Cloud Run service.
2. Preserve the old service and `primary:2` secret version as immutable recovery evidence.
3. Complete one authorized Plus E2E as the expected Kakao user and retain its successful result in
   that user's history.
4. Remove the temporary multi-account E2E sharding surface after every E2E provider run and cost is
   settled.
5. Stop treating a definite non-2xx Apify API response as an ambiguous Actor start.

## Non-goals

- Do not disable or delete any Secret Manager version.
- Do not mutate `ai-baram-v2-apify-primary:2` or make an existing version hold another token.
- Do not add automatic account pooling, quota bypass, or provider failover.
- Do not retry an Actor start after a transport timeout or any response whose run-creation outcome
  is unknown.
- Do not delete the completed E2E result from the owner's history.

## Considered Cutover Approaches

### 1. New-service transfer, selected

Create a fresh Cloud Run service whose first revision references
`ai-baram-v2-apify-primary:1`. Drain the current service before changing Vercel task targets and
Scheduler targets. Because the new service has no prior credential identity, the existing deploy
invariant remains intact. Rollback restores the old target URLs; the old service and its secret
reference are never changed.

### 2. Direct in-place `primary:2` to `primary:1` update, rejected

This is operationally short but violates the repository's same-slot immutability rule. Historical
ledger rows store the logical slot, not a credential epoch, so the change would make account
identity time-dependent and would bypass the reviewed deploy guard.

### 3. DB-backed credential epochs and audited in-place rotation, deferred

Adding a credential-version identity to every provider ledger and cost event would make future
in-place rotations auditable. It is a broader schema and lifecycle project and is unnecessary for
this one cutover because a new-service transfer already preserves identity.

## Cutover Architecture

The cutover uses three private Cloud Run services during the operation:

- `analysis-worker`: current recovery-only service, still bound to `primary:2`.
- `analysis-worker-primary-e2e`: temporary E2E service, bound to `primary:1` and the additional
  numeric slot references required by the approved operation split.
- `analysis-worker-primary`: final production service, bound only to `primary:1` after the E2E is
  terminal and reconciled.

Each service uses the exact reviewed application image/source commit, runtime service account,
non-secret runtime policy, scaling limits, and HMAC/Supabase/image-secret pins. Only the service
name, self-origin task URLs, and allowed Apify references differ.

Vercel remains the admission and task-enqueue surface. A production deployment captures the task
target URL and OIDC audience for the currently selected worker. Cloud Tasks do not rewrite already
created task URLs, so every transition requires a zero-task drain before Vercel is redeployed.
The two maintenance Scheduler jobs move to the same selected worker only after that worker is Ready
and its invoker policy is verified.

## Operational Sequence

1. Wait for the failed preflight to expire and for its provider row to be quiet for at least 30
   minutes.
2. Repeat the exact old-account Actor audit. If any matching run exists, stop. Otherwise generate
   and execute the owner-only no-run resolver SQL, then confirm the row is no longer unresolved.
3. Require zero processing requests, claimed/running jobs, active or unreconciled provider rows,
   cleanup intents, media artifacts, and queued tasks.
4. Merge the definite-start-rejection fix and deploy that exact commit to Vercel.
5. Create `analysis-worker-primary-e2e` with `primary:1` plus the reviewed temporary slot refs. Keep
   it private and grant only the task and maintenance service accounts `run.invoker`.
6. Verify the new revision's image/source SHA, secret refs, runtime gates, IAM, single-revision
   traffic, and health endpoint before directing work to it.
7. Update the four Vercel task URL/audience variables and both Scheduler URIs to the temporary
   service. Redeploy the exact merged commit and verify the captured environment without printing
   secrets.
8. Run exactly one authorized Plus E2E. Verify preflight reuse, provider lineage, terminal costs,
   result visibility, history retention, queue drain, artifact cleanup, and absence of unresolved
   rows.
9. Disable the authorized-test sharding policy and redeploy Vercel.
10. Create `analysis-worker-primary` with only `primary:1`, switch Vercel and Scheduler targets after
    a second zero-work drain, and remove invoker bindings from both recovery-only services.
11. Keep all services and secret versions undeleted. Record the final active service, revision,
    source SHA, secret pin, and E2E evidence without tokens or user content.

## Definite Actor Start Rejection

### Classification

`apify-client` constructs `ApifyApiError` only when the HTTP request reached Apify and Apify
returned a non-2xx API error. This is a definite rejected start, not an unknown transport outcome.
Network errors, local deadlines, connection resets, and untyped failures remain ambiguous.

### Provider callback

Extend `ProviderRunCheckpoint` with an optional `onRunStartRejected` callback. The callback receives
only the immutable provider identity plus bounded `statusCode` and sanitized provider error `type`.
It never receives or persists the provider message, request payload, token, or user input.

`startOrResumeApifyActor` follows this order:

1. Persist the existing start reservation.
2. Call the Actor start once.
3. On `ApifyApiError`, persist the definite rejection through `onRunStartRejected` and throw a
   sanitized `SCRAPING_PROVIDER_START_REJECTED_ERROR`.
4. On any other start error, throw the existing `SCRAPING_AMBIGUOUS_START_ERROR` and never retry.

A failure to persist the rejection remains a persistence incident. It must not authorize a second
Actor start.

### Ledger state

Add terminal status `rejected` to both preflight and request provider ledgers. A rejected row has:

- `run_id = NULL`
- no run-start timestamp
- a terminal timestamp
- `actual_usage_usd = 0`
- a usage-reconciled timestamp
- a bounded HTTP status and sanitized provider error type where the ledger supports metadata

Preflight acquisition cost history records a distinct `provider_start_rejected` event with zero
maximum and actual charge. It must not reuse `manual_no_run`, which is reserved for owner-confirmed
external evidence. Retention, readiness, cleanup, and cost aggregation treat `rejected` as terminal
and reconciled.

### Error handling

- Quota, validation, payment, permission, and other `ApifyApiError` responses fail the current
  operation without retrying or leaving an ambiguous row.
- The public preflight response remains the existing sanitized `ANALYSIS_FAILED` result.
- Request workers retain their existing terminal cleanup behavior, now with no active provider run
  to abort or reconcile.
- Raw Apify error messages never enter PostgreSQL, application logs, or client responses.

## Verification

### Automated

- A real `ApifyApiError` fixture must first reproduce the current ambiguous classification in a
  failing unit test.
- Unit tests prove that the rejection callback is called once, no run checkpoint is attempted, no
  wait occurs, and the thrown error is the sanitized definite-rejection code.
- Existing deadline/network tests continue to prove ambiguous behavior and a single Actor start.
- PGlite tests prove preflight and request ledger transitions to `rejected`, zero actual cost,
  idempotency, identity conflicts, retention, readiness, and long-term cost-event behavior.
- Migration contract tests prove constraints, grants, security-definer search paths, and absence of
  raw provider messages.
- The complete relevant Vitest, migration, typecheck, lint, build, and infrastructure-script suites
  pass before merge.

### Production

- Fingerprints prove the temporary and final service `primary` ref resolves to local
  `APIFY_PRIMARY_API_TOKEN`, without printing either value or fingerprint.
- Cloud Run and Vercel source SHAs match the merged commit.
- Exactly one production worker is targeted by new tasks and both maintenance jobs.
- The authorized Plus request completes, all paid runs and costs reconcile, queues and artifacts
  drain, and the result is visible in the expected owner's history.
- The final worker exposes no temporary non-primary Apify references and the recovery-only services
  have no task or maintenance invoker binding.

## Rollback

Before the temporary E2E service receives work, rollback is a no-op because the old service remains
active. After a target switch, restore the previous four Vercel task target/audience values, deploy
the last known-good Vercel source, and restore both Scheduler URIs. Do not change a secret version
or delete either service during rollback. If any provider run is active or unreconciled, stop the
rollback transition until that exact service and credential identity completes recovery.

## Security and Privacy

- Token comparisons output booleans only.
- No token, hash, provider message, Instagram identifier, Kakao credential, or 2FA code is written to
  source, command output, evidence, or logs.
- Evidence contains bounded counts, timestamps, service/revision names, source SHAs, logical slots,
  numeric secret versions, and costs only.
- Every new Cloud Run service remains authenticated and uses resource-scoped secret access and
  invoker IAM.
