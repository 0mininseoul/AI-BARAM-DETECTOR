# Instagram V2 Launch Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete one authorized `0_min._.00` Standard Instagram V2 E2E in under 280 seconds with a durable result, complete evidence/cost telemetry, and no regression to Groble early-bird isolation; then report, but do not implicitly authorize, the separate distributed-concurrency and rollout gates.

**Architecture:** Keep the existing self-hosted-primary/Apify-fallback boundary and strict 90% per-batch evidence rule. First replay the 15 known incomplete profiles through a paid, explicitly confirmed micro-canary. If that gate passes, add one bounded and durable Apify repair run for only the exact terminal `incomplete` rows, remove false cross-credential serialization with per-account capacity plus profile/non-profile sublimits, and produce a PII-free launch-readiness report. Run one final signed E2E only after review, CI, deployment, quota checks, and explicit approval. A fenced, expiring PostgreSQL Gemini lease is a later mandatory gate before concurrent or automatic paid admission, not a prerequisite for the single operator-controlled E2E.

**Tech Stack:** TypeScript, Zod, Vitest, PGlite, Supabase PostgreSQL/RPC, Apify Client, Google Vertex Gemini, Cloud Tasks, Cloud Run, Next.js 16, Vercel, Playwright/gstack browser QA, GitHub Actions.

---

## Decision

Do not run another full E2E yet. The recommended path is:

1. prove on the exact 15 incomplete accounts that the same official Apify profile Actor can recover transient incomplete rows;
2. implement one exact-set repair run plus credential-slot-aware concurrency;
3. merge, deploy, and run the full authorized E2E once;
4. after that report, stop. Implement the distributed Gemini lease and collect controlled Basic/Standard samples only under a separately approved follow-up plan before automatic launch.

This is preferred over the alternatives:

- A new self-hosted proxy/egress path is not the immediate fix. The current Cloud Run path produced `0/238` self-hosted successes, so proxy selection, session policy, privacy, and reliability would become a new project before the first completed result.
- A different community Apify Actor is not the immediate fix. It would replace the parser, pricing, error attribution, and durable resume contract at once. Reconsider it only if the exact-set micro-canary below fails.
- Relaxing the 90% rule, reclassifying public profiles as private, retrying every profile, or rotating free credentials automatically is forbidden.

The official [`apify/instagram-profile-scraper` input contract](https://apify.com/apify/instagram-profile-scraper/input-schema) exposes the bounded username input already used by production. The planned concurrency of eight stays below Apify's documented account-level [concurrent Actor-run limits](https://docs.apify.com/limits), but account [plan credit](https://apify.com/pricing) still does not prove an individual Actor's daily quota. Therefore eight is enabled only after an Actor-specific quota/balance precheck and a small canary.

## Current Evidence and Root Cause

Planning baseline is clean `main == origin/main == fc4801a80ee6ad331e86a5280997a3f06e32f718`. The earlier required baseline `321e810` has already advanced through reviewed fixes in PRs `#46` and `#47`.

The latest authorized failed source request (loaded at execution time from the operator-only `AUTHORIZED_SOURCE_REQUEST_ID`) showed:

- wall time: `300.143s`, terminal error `ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE`;
- relationships: followers `470/470`, following `635/635`, mutual `383`, public `238`, private `145`;
- self-hosted profiles: `0/238` successes;
- Apify exact fallback: `223/238` successes and `15` incomplete rows;
- batch 7: `25/28 = 89.29%`, one success short of the intentional `90%` boundary;
- profile span: `235.270s`; the eight profile runs completed in serialized waves despite using sharded credentials elsewhere;
- Gemini: `304` calls, no retries, one call with missing usage metadata;
- measured lower-bound cost: Apify `$2.19545`, Gemini `$0.44284725` plus one unknown call, Cloud Run list price `$0.0170937`;
- no final result was produced, so result rendering, carousel/reel evidence at completion, interaction score presentation, recent-mutual badge, and private-name ordering remain unproven.

Two code facts explain the next work:

1. `lib/services/instagram/providers/apify-relationship.ts` has one process-global Actor semaphore, so independent credential slots unnecessarily block one another.
2. `getProfilesBatchV2` has one durable paid fallback operation. A small transient incomplete set cannot be retried without either rerunning the whole batch or adding a second, separately fenced provider operation.

### Hypotheses and falsifiers

Treat correctness and performance as separate hypotheses and change one variable at a time:

- **H1, correctness:** the 15 strict-parser incompletes are transient Actor/session outcomes, so a fresh run of the exact same accounts can recover enough evidence without a new provider. The two-run micro-canary is the minimal test. Either run below `14/15` successful profiles, more than one explicit unavailable, any schema/non-incomplete failure, or failure to recover one critical-batch row falsifies H1 and stops the repair implementation.
- **H2, performance:** eight profile batches shared one profile credential and the current concurrency of two, while the process-global semaphore also permits unrelated credential work to cause head-of-line blocking. Deferred-promise tests must prove both cross-slot blocking and the mixed-class create-first limit bug. Per-account capacity plus deterministic profile/non-profile sublimits must then raise only controlled profile work to eight while keeping relationship/interaction work at two. The final E2E profile lane must fall below `150s`; otherwise return to timing evidence rather than raising concurrency again.
- **H3, launch proof:** existing raw working data is purged before a completed request can be fully audited, while current long-term telemetry lacks reel/carousel/interaction policy counts. A PGlite terminalization test must demonstrate the missing evidence before adding the PII-free capture. If existing durable tables can satisfy a proposed field without retaining raw data, reuse them instead of duplicating it.

If three attempted fixes fail in one domain, stop and revisit the provider/egress or orchestration architecture with the user; do not stack a fourth patch.

## Hard Invariants

- Never print, persist in PostgreSQL, commit, or return an `APIFY_*` token.
- Never make a paid API call without the CLI confirmation flag **and** fresh explicit user approval in the executing session.
- Never buy an Apify plan, add credit, rotate a secret version, or make a real Groble payment without separate explicit approval.
- Public V2 admission remains disabled throughout the one-off E2E.
- Load the authorized owner UUID/email from operator-only `AUTHORIZED_E2E_OWNER_ID` and `AUTHORIZED_E2E_OWNER_EMAIL`; never commit or print them. The only target committed to this plan is the user-authorized `0_min._.00`.
- Normal production uses one configured credential. Test sharding never becomes automatic free-account rotation.
- Initial Apify fallback receives exactly the primary unresolved set. Repair receives exactly the first Apify run's terminal `incomplete` subset, never successes, unavailable rows, or unrelated usernames.
- A schema-contaminated, unattributed, duplicate, auth, quota, or transport-wide fallback does not authorize repair. It fails closed.
- Candidate batch completeness stays at 90%; relationship completeness stays at 99%; target-profile evidence stays strict.
- Reel analysis uses its thumbnail; carousel collection and first/middle/last selection remain bounded; slide captions remain aligned with slide evidence; no new provider or Gemini calls are introduced for captions.
- QA `payment_pending` orders consume neither inventory nor analysis work. Basic and Standard remain independently capped at 10; Plus remains waitlist-only.
- All implementation uses isolated worktrees/branches, TDD, a PR, independent review, green CI, merge to `main`, and post-merge deployment verification.

## Definition of Done

### Authorized one-off E2E

- Request status is `completed` and the authenticated owner can reopen the result from `/history` after leaving the mobile browser.
- The one-time entitlement nonce/JTI maps to exactly one reciprocal preflight/request with zero siblings under replay/double-click/crash recovery.
- Total request wall time is `<280,000ms`, leaving at least 20 seconds of margin under the five-minute requirement.
- Followers and following equal their declared full counts; mutual/public/private counts are internally consistent; girlfriend exclusion is absent from every downstream set.
- Every profile batch has at least 90% terminal evidence; only bounded `incomplete` or explicit unavailable rows are tolerated by the existing policy.
- The initial fallback exact-set invariant and optional repair-subset invariant are both true.
- Self-hosted attempts, network requests, circuit/global-gate outcomes, HTTP failures, latencies, fallback count, repair count, and final provenance counts are available without exposing usernames.
- Reel thumbnail, carousel slide selection, slide-caption alignment, media-bundle count/size, and Gemini media-count policies have numeric, PII-free evidence.
- Target liker/comments and reverse-liker stages ran; final score/risk-band policy version and UI presentation agree.
- Every Gemini stage reports model, thinking level, calls, retries, input/output/thinking tokens, latency, and modeled cost. `aiMissingUsageCount` must be zero before the token-priced estimate is called complete; billing-export actual remains labeled separately.
- Apify actual cost is reconciled, Gemini token telemetry is complete, and Cloud Run/Tasks metering-times-list-price cost is measured from preflight start through terminal cleanup. Isolated Vertex/GCP billing-export actual is reconciled when available and is never conflated with modeled/list-price cost. No active/unreconciled preflight/request runs, jobs, tasks, or artifacts remain.
- The Groble QA order is unchanged and the QA workflow's delta against the captured Basic/Standard inventory baseline is zero. Legitimate external sales during the window are identified separately.

This E2E establishes collection completeness and consistency with the reviewed sorting, media, interaction, scoring, and UI policies. It does not establish semantic model accuracy against reality because no labeled ground-truth dataset or acceptance tolerance exists in scope. Any claim such as precision, recall, or relationship-detection accuracy requires a separate consented ground-truth evaluation plan.

### Automatic paid launch

The single E2E does **not** authorize automatic launch. That later gate additionally requires:

- a deployment-wide fenced Gemini lease capped at 8 across revisions, matching the controlled worker dispatch/concurrency envelope;
- controlled one-at-a-time Basic and Standard samples sufficient to compute p50/p95 duration and cost, including failed/abandoned acquisition cost;
- zero unknown-cost samples in the launch window, or a separately approved conservative pricing policy that never describes a bound as exact;
- reviewed error-rate, media, result, mobile-resume, and early-bird operational evidence;
- a separate explicit admission decision. Plus remains waitlist-only.

## File Map

### PR 1: Paid micro-canary tooling and documentation consistency

- Create `supabase/migrations/20260718123000_add_profile_repair_canary_journal.sql`: service-role-only, PII-free reservation/run/terminal/cost journal for the two approved canary repetitions.
- Create `lib/services/analysis/profile-repair-canary-run-store.ts`: deterministic reserve, confirm-start, resume, terminalize, and ambiguous-start adapter.
- Create `lib/services/analysis/profile-repair-canary-run-store.test.ts`: state-machine, idempotency, and redaction tests.
- Create `lib/services/analysis/profile-repair-canary-run-migration-contract.test.ts`: RLS, revokes, fixed actor, and PII-free schema contract.
- Create `lib/services/analysis/profile-repair-canary-run-pglite.test.ts`: crash/replay and conflicting reservation integration tests.
- Create `scripts/canary-apify-profile-repair-options.ts`: strict CLI parsing, source-run replay selection, fixed paid ceiling, and sanitized result model.
- Create `scripts/canary-apify-profile-repair-options.test.ts`: zero-cost and redaction contracts.
- Create `scripts/canary-apify-profile-repair.ts`: read-only replay of existing source runs and explicitly confirmed fresh canary runs.
- Create `scripts/canary-apify-profile-repair.test.ts`: mocked service-role ledger ownership, existing-run replay, paid-start count, and cost-stop contracts.
- Modify `scripts/canary-instagram-provider-errors.ts`: reuse only generic safe error categorization if the new canary needs it.
- Modify `package.json`: add `canary:apify-profile-repair`.
- Modify `docs/authorized-apify-sharded-e2e-runbook.md`: add micro-canary procedure and stop gates.
- Modify `docs/operations-cost-model.md`: describe repair as a separately metered operation and correct the stale combined-15 statement to independent Basic/Standard limits of 10.
- Modify `docs/groble-earlybird-operations.md`: cross-link the unchanged inventory invariant; do not change Groble products or landing copy.

### PR 2: Exact durable profile repair

- Create `lib/domain/analysis/profile-repair-policy.ts`: pure eligibility and exact subset selection.
- Create `lib/domain/analysis/profile-repair-policy.test.ts`: threshold, category, and cap tests.
- Modify `lib/services/instagram/scraper.ts`: one bounded repair attempt after the durable fallback.
- Modify `lib/services/instagram/scraper-v2.test.ts`: crash/resume, merge, and no-overfetch tests.
- Modify `lib/services/analysis/v2-collection-executors.ts`: lazily bind the distinct `profile-repair` provider run while reusing the profile-fallback credential mapping.
- Modify `lib/services/analysis/v2-collection-executors.test.ts`: durable lifecycle and exact operation identity tests.
- Modify `lib/services/analysis/v2-provider-run-store.ts`: add the `profile-repair` ledger kind.
- Modify `lib/services/analysis/v2-provider-run-store.test.ts`: operation-key domain tests.
- Modify `lib/services/analysis/v2-provider-run-migration-contract.test.ts`: forward-validator contract.
- Create `lib/services/analysis/v2-profile-repair-audit-store.ts`: persist initial and repair PII-free aggregates before merged fallback evidence replaces attempt detail.
- Create `lib/services/analysis/v2-profile-repair-audit-store.test.ts`: immutable/idempotent aggregate and exact-subset contracts.
- Create `lib/services/analysis/v2-profile-repair-audit-pglite.test.ts`: crash-boundary and terminal provenance integration tests.
- Create `supabase/migrations/20260718130000_add_analysis_v2_profile_repair_operation.sql`: add the new operation prefix and service-role-only repair-audit row without weakening RLS or fences.
- Modify `docs/analysis-v2-provider-lifecycle-runbook.md`: document repair resume and cleanup.
- Modify `docs/operations-cost-model.md`: add `R`, the exact repaired-row cost.

### PR 3: Credential-slot-aware Actor capacity with class sublimits

- Modify `lib/services/instagram/providers/apify-relationship.ts`: coordinate an account-level semaphore per effective slot plus deterministic `profile|non_profile` class sublimits.
- Modify `lib/services/instagram/providers/apify.ts`: classify profile calls separately while relationship calls use the shared non-profile class.
- Modify `lib/services/instagram/providers/apify-interactions.ts`: route interaction calls through the same non-profile class for that physical slot.
- Modify `lib/services/instagram/providers/apify.test.ts`: account cap, mixed-class sublimit, same-class cap, and cross-slot independence tests.
- Modify `lib/services/instagram/providers/apify-interactions.test.ts`: persisted-slot concurrency regression.
- Modify `docs/authorized-apify-sharded-e2e-runbook.md`: set controlled concurrency and quota prechecks.

### PR 4: Launch evidence, readiness, and cost completeness

- Create `supabase/migrations/20260718143000_add_analysis_v2_launch_evidence.sql`: preserve collection-time profile origin/histogram telemetry plus PII-free media/interaction launch evidence and sticky capture health before terminal cleanup.
- Modify `lib/domain/analysis/profile-fetch-outcome.ts`: add a bounded attempt-origin field that distinguishes self-hosted `network|global_gate|circuit` without changing failure category.
- Modify `lib/domain/analysis/profile-fetch-outcome.test.ts`: origin/source cross-field and fail-closed schema tests.
- Modify `lib/services/instagram/providers/profile-attempt.ts`: derive origin from typed provider outcomes, never arbitrary message substrings.
- Modify `lib/services/instagram/providers/profile-attempt.test.ts`: exact global-gate/circuit/network attribution and near-match negatives.
- Modify `lib/services/instagram/providers/selfhosted/global-request-gate.ts` and its tests: expose one typed, sanitized pre-network coordination failure.
- Modify `lib/services/instagram/providers/selfhosted/web-client.ts` and its tests: expose typed circuit versus global-gate origin while preserving the existing safe failure category and request-start callback.
- Modify `lib/services/instagram/scraper.ts` and `lib/services/instagram/scraper-v2.test.ts`: carry immutable origin through primary checkpoint/fallback selection.
- Modify `lib/services/analysis/v2-profile-fetch-store.ts` and `lib/services/analysis/v2-profile-fetch-store.test.ts`: persist origin at collection time and emit fixed latency buckets crash-safely.
- Modify `lib/services/analysis/test-entitlement-consumption.test.ts` and `lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts`: prove one entitlement JTI/nonce can produce exactly one preflight/request under double-click, replay, and crash recovery.
- Modify `lib/services/analysis/test-entitlement.ts` and `lib/services/analysis/test-entitlement.test.ts`: make the signed admission and entitlement payloads carry the reviewed paid-call confirmation claim and reject legacy/unconfirmed payloads for this authorized run.
- Modify `scripts/issue-analysis-test-admission.ts`, `scripts/issue-analysis-test-entitlement.ts`, and their new CLI tests: require the exact `--confirm-paid-api-call` boolean flag before emitting either signed token.
- Modify `lib/services/analysis/preflight-route.test.ts` and `lib/services/analysis/test-entitlement-route.test.ts`: prove a missing flag cannot yield a usable signed token and produces zero preflight, request, or provider starts.
- Create `lib/services/analysis/v2-launch-evidence-migration-contract.test.ts`: privacy, bounds, RLS, and capture-order contract.
- Create `lib/services/analysis/v2-launch-evidence-pglite.test.ts`: completion/failure/conflict capture, sticky health, collection-origin, and purge integration.
- Create `lib/services/analysis/v2-launch-evidence-upgrade-pglite.test.ts`: apply the forward migration over representative legacy terminal/request/profile-telemetry fixtures and prove the explicit version/backfill policy.
- Create `lib/services/analysis/v2-launch-readiness.ts`: strict schema and pure pass/fail evaluator.
- Create `lib/services/analysis/v2-launch-readiness.test.ts`: all timing, coverage, cost, and cleanup gates.
- Create `lib/services/analysis/v2-gcp-cost-evidence.ts`: validate a request-bound, deployed-revision-bound metering evidence file and reject missing/foreign windows.
- Create `lib/services/analysis/v2-gcp-cost-evidence.test.ts`: schema, path, revision, time-window, and redaction tests.
- Create `scripts/report-analysis-v2-launch-readiness.ts`: sanitized operator report.
- Modify `package.json`: add `report:analysis-v2-readiness`.
- Modify `docs/authorized-apify-sharded-e2e-runbook.md`: add final-run acceptance.
- Modify `docs/operations-cost-model.md`: forbid counting unknown Gemini usage as zero.

### PR 5: Deployment-wide Gemini lease, required before automatic launch

- Create `supabase/migrations/20260718160000_add_analysis_v2_gemini_leases.sql`: eight fixed fenced/quarantinable slots, worker RPCs, and a DB-owner-only audited quarantine-resolution function.
- Create `lib/services/analysis/v2-gemini-lease-store.ts`: validation and acquire/reserve/release/quarantine adapter.
- Create `lib/services/analysis/v2-gemini-lease-store.test.ts`: application-level fence tests.
- Create `lib/services/analysis/v2-gemini-lease-migration-contract.test.ts`: SQL security and shape tests.
- Create `lib/services/analysis/v2-gemini-lease-pglite.test.ts`: cross-worker cap, safe-expiry recovery, ambiguous quarantine, stale-release, and claim-fence tests.
- Modify `lib/services/analysis/v2-ai-result-store.ts`: acquire before attempt reservation and release only after durable terminalization.
- Modify `lib/services/analysis/v2-ai-result-store.test.ts`: hook ordering, failure, retry, and checkpoint replay tests.
- Modify `lib/services/ai/gemini.ts`: add the hard request timeout/single-SDK-attempt contract and preserve only the three allowlisted capacity/deadline/quarantine signals from the durable pre-attempt hook.
- Modify `lib/services/ai/gemini.test.ts`: each of the three allowlisted signals causes zero SDK calls and no fabricated attempt telemetry.
- Modify `lib/services/ai/stage-policy.ts`: change enforcement scope from process-only to process-plus-distributed without changing per-stage model/thinking policy.
- Modify `lib/services/ai/stage-policy.test.ts`: retain local caps and assert the distributed cap contract.
- Modify `lib/services/analysis/v2-worker.ts`: classify temporary lease exhaustion as retryable and preserve job fencing.
- Modify `lib/services/analysis/v2-worker.test.ts`: no paid attempt on capacity wait, no terminal request failure from brief contention.
- Modify `lib/services/analysis/v2-job-store.ts` and `lib/services/analysis/v2-job-store.test.ts`: add a fenced quarantine deferral that schedules recovery without consuming the ordinary failure-attempt budget.
- Modify `lib/services/analysis/v2-worker-error-codes.ts`: allowlist capacity-pending, deadline-too-short, and quarantine-active nonterminal codes instead of collapsing them to a permanent generic failure.
- Modify `lib/services/analysis/v2-worker-error-codes.test.ts`: exact-code allowlist and unknown-code fail-closed tests.
- Modify `app/api/analysis/v2/worker/route.ts`: pass a monotonic handler deadline into execution so no generation starts with less than `225s` of the `300s` request window remaining.
- Modify `lib/services/analysis/v2-worker-route.test.ts`: handler-deadline propagation and transient response tests.
- Modify `lib/services/analysis/v2-launch-readiness.ts` and `lib/services/analysis/v2-launch-readiness.test.ts`: block automatic readiness on any quarantined Gemini slot.
- Modify `lib/services/analysis/preflight.ts` and `lib/services/analysis/preflight-route.test.ts`: map the database quarantine gate to a sanitized unavailable response.
- Modify `lib/services/analysis/test-entitlement-consumption.ts` and `lib/services/analysis/test-entitlement-route.test.ts`: prove signed admission cannot bypass quarantine.
- Modify `docs/authorized-apify-sharded-e2e-runbook.md`: replace the early-access exception with the distributed gate and quiescent first rollout.
- Modify `docs/operations-cost-model.md`: document the deployment-wide generation cap.

## Task 0: Freeze the Baseline and Create the First Isolated Worktree

- [ ] **Step 1: Re-read the handoff and required runbooks**

Read the promotion-ready checkpoint and the latest failed-run checkpoint first, then the seven required documents. Treat checkpoints as evidence, not as permission to spend.

```bash
sed -n '1,260p' /Users/youngminpark/.gstack/projects/0mininseoul-AI-BARAM-DETECTOR/checkpoints/20260718-045802-promotion-ready-handoff.md
sed -n '1,260p' /Users/youngminpark/.gstack/projects/0mininseoul-AI-BARAM-DETECTOR/checkpoints/20260718-120143-authorized-instagram-e2e-provider-blocked-handoff.md
sed -n '1,260p' docs/authorized-apify-sharded-e2e-runbook.md
sed -n '1,260p' docs/analysis-v2-provider-lifecycle-runbook.md
sed -n '1,230p' docs/operations-cost-model.md
sed -n '1,230p' docs/private-account-name-sort.md
sed -n '1,460p' docs/superpowers/plans/2026-07-13-launch-pipeline-v2.ko.md
sed -n '1,420p' docs/superpowers/plans/2026-07-16-carousel-slide-caption-implementation.md
sed -n '1,220p' docs/groble-earlybird-operations.md
```

- [ ] **Step 2: Verify the repository state without changing it**

```bash
git fetch origin
git status --short --branch
git rev-parse main
git rev-parse origin/main
git diff --exit-code
git diff --cached --exit-code
```

Expected at planning time: `main` and `origin/main` both resolve to `fc4801a80ee6ad331e86a5280997a3f06e32f718`; after the plan PR lands, use that newer shared head. Any divergence or dirty file stops execution.

- [ ] **Step 3: Create only the first gated worktree**

Use the `using-git-worktrees` skill. Never let parallel agents edit the same worktree.

```bash
git worktree add ../ai-baram-detector-profile-canary -b feat/apify-profile-repair-canary origin/main
```

Create each later worktree only at its stated gate below. PR 2 waits for merged PR 1 plus a passing paid micro-canary. PR 3 may start from the post-PR-1 main head, but its deployment value stays disabled until the canary passes. PR 4 waits for merged PR 2 so launch evidence understands `profile-repair`. PR 5 is a separate follow-up plan and is not authorized by this one-off E2E plan. Assign each active worktree to a separate agent; never exceed the available agent slots or allow two agents to share files.

- [ ] **Step 4: Capture zero-cost operational invariants**

Perform read-only checks and record only counts/statuses:

- no active V2 request, claimed/running job, active provider run, queue task, or stale media cleanup;
- Vercel production and Cloud Run resolve to the same reviewed SHA;
- Cloud Run has one revision at 100%, max instances 1, concurrency 8;
- public admission is false;
- QA Standard order is `payment_pending`, has no paid/due/result/sequence side effect;
- capture the current Basic and Standard sold/reserved/remaining counters as the pre-run baseline. The QA workflow must later produce a delta of zero; legitimate external sales during the window are recorded separately and are not treated as a regression.

Do not display token values, raw usernames other than the authorized target, or customer payloads.

## Task 1: Build the Zero-Cost Replay and Explicitly Paid Micro-Canary

Use `test-driven-development`. The default invocation must make zero Actor starts.

- [ ] **Step 1: Write failing CLI and redaction tests**

In `scripts/canary-apify-profile-repair-options.test.ts`, cover:

```ts
expect(parseProfileRepairCanaryArgs([
    '--source-request-id', SOURCE_REQUEST_ID,
    '--critical-job-key', 'track:profiles:batch:7',
])).toMatchObject({
    confirmPaidApiCall: false,
    repeats: 0,
    maximumTotalChargeUsd: 0,
});

expect(() => parseProfileRepairCanaryArgs([
    '--confirm-paid-api-call',
])).toThrow('source request');

expect(sanitizeProfileRepairCanaryResult({
    requestedUsernames: ['sensitive.user'],
    token: 'secret',
    requestedCount: 15,
})).toEqual({ requested_count: 15 });
```

Also prove:

- `--source-request-id` is one UUID and `--critical-job-key` is exactly one `track:profiles:batch:N` key;
- `--credential-slot` accepts one explicit known slot and never rotates;
- `--confirm-paid-api-call` fixes `repeats=2`, per-run maximum charge at `$0.05`, and total exposure at `$0.10`; callers cannot raise these values;
- JSON/stdout contains no username, run ID, dataset ID, token, input hash material, URL, or raw provider message;
- an unconfirmed run can replay and classify existing datasets but the mocked Actor `start` method is never called.

In `scripts/canary-apify-profile-repair.test.ts`, use injected Supabase and Apify clients to prove the script rejects the wrong owner/target/pipeline/status, non-profile actors, wrong credential slots, non-terminal ledger rows, missing or duplicate batch jobs, and any source run ID not loaded from the protected request ledger. Add `profile-repair-canary-run-store` contract/PGlite failures proving:

- dry replay writes no canary journal and starts no Actor;
- a confirmed repetition reserves a deterministic `(source_request_id, canary_version, repetition)` row before Actor start;
- the existing lifecycle `onRunStarted` callback durably stores the confirmed provider run ID before waiting for completion;
- rerunning the same command resumes a confirmed run ID or returns an already-terminal result, and never starts a second Actor for that repetition;
- a `starting` reservation with no confirmed run ID is `ambiguous`, cannot be automatically retried, and blocks the next repetition;
- terminal actual usage and safe counts are idempotent, while conflicting terminal writes fail closed;
- usage reconciliation polls for at most `180s`; timeout exits safely with the confirmed run resumable, conservative cost status, and no next repetition;
- anon/authenticated roles cannot read the table or execute its RPCs, and the schema cannot store usernames, URLs, payloads, tokens, or raw errors.

- [ ] **Step 2: Run the tests and verify the intended failure**

```bash
npx vitest run scripts/canary-apify-profile-repair-options.test.ts
```

Expected before implementation: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict argument and output policy**

`scripts/canary-apify-profile-repair-options.ts` exports pure parsing and sanitization. Keep monetary ceilings as constants, not CLI options:

```ts
export const PROFILE_REPAIR_CANARY_REPEATS = 2;
export const PROFILE_REPAIR_CANARY_MAX_RUN_USD = 0.05;
export const PROFILE_REPAIR_CANARY_MAX_TOTAL_USD = 0.10;
export const PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT = 15;
```

The sanitized report contains only:

```ts
{
    mode: 'replay' | 'paid_canary';
    source_run_count: number;
    requested_count: number;
    critical_incomplete_count: number;
    runs: Array<{
        repetition: 1 | 2;
        lifecycle_status: 'succeeded' | 'failed' | 'ambiguous' | 'not_started';
        terminal_count: number;
        success_count: number;
        unavailable_count: number;
        incomplete_count: number;
        other_failure_count: number;
        latency_ms: number;
        actual_cost_usd: number | null;
        cost_status: 'actual' | 'conservative' | 'unknown';
        gate_passed: boolean;
    }>;
    total_actual_cost_usd: number | null;
    session_maximum_exposure_usd: number;
    cost_status: 'actual' | 'conservative' | 'unknown';
    gate_passed: boolean;
}
```

- [ ] **Step 4: Implement read-only source-run replay first**

In `scripts/canary-apify-profile-repair.ts`:

1. load the source `analysis_requests` row through service role and require the exact authorized owner, target `0_min._.00`, pipeline V2, and failed terminal status;
2. load only that request's `track:profiles:batch:*` `profile-fallback:` provider-ledger rows; require eight unique batch keys, `succeeded`, non-null run IDs, actor `apify/instagram-profile-scraper`, and the one explicitly selected credential slot;
3. load one explicitly selected token through `getApifyClient`; never read or enumerate other slots;
4. for each ledger-owned run, read its `INPUT` record through `client.run(runId).keyValueStore().getRecord('INPUT')` and terminal dataset through `client.run(runId).dataset()` without starting, resurrecting, or aborting an Actor;
5. validate every source input is a unique bounded username list and every dataset is parsed by the production `getProfilesBatchOutcomes` path through `resumeRunId`;
6. select only `status='failed' && failureCategory='incomplete'`;
7. reject missing/extra ledger rows, duplicates, schema contamination, unattributed rows, non-incomplete failures, or any union count other than exactly 15;
8. retain the critical job's membership only in memory and print only its incomplete count;
9. in default replay mode, print the sanitized report and exit before any fresh Actor call.

Do not introduce a second profile parser in the script.

- [ ] **Step 5: Add the confirmed paid branch**

Only when `--confirm-paid-api-call` is present, use `analysis_v2_profile_repair_canary_runs` as a protected provider journal. Each row stores only the source request foreign key, fixed canary version/actor ID, explicit credential slot, repetition, requested count `15`, maximum charge, reservation identity, state (`starting|running|succeeded|failed|ambiguous`), confirmed provider run ID, safe terminal counts, actual usage when settled, and timestamps. It stores no username list, input hash/fingerprint, URL, or provider payload. The immutable terminal source request and its provider ledger are the selection authority, so a linkable username hash is unnecessary.

The paid branch runs in this order:

1. reserve repetition 1 before calling Apify;
2. start it through the existing no-retry Apify lifecycle and fixed `$0.05` `maxTotalChargeUsd`, persisting the confirmed run ID through the lifecycle callback before any `waitForFinish`;
3. on process restart, resume only the journal-owned confirmed run ID; never start a replacement;
4. if start returns ambiguously before the ID is durable, mark/retain `ambiguous`, stop the command, require a manual Apify account audit, report cost as unknown with the conservative ceiling, and do not attempt repetition 2;
5. parse the terminal dataset with the production strict outcome parser, poll provider accounting for at most `180s`, and terminalize the journal row before printing;
6. start repetition 2 only when repetition 1 is terminal, gate-passing, and fully cost-reconciled;
7. repeat the same crash-safe lifecycle for repetition 2 and emit only the sanitized summary.

The second run is part of the approved maximum exposure, not an unconditional start. Any ambiguity, failed gate, unsettled cost, reconciliation timeout, or conservative exposure above the remaining `$0.10` budget stops it. Reinvoking the identical command after a reconciliation timeout may only resume/reconcile the confirmed run; it cannot start a replacement. If reconciliation later makes repetition 2 eligible, obtain fresh explicit paid-call approval in that executing session before invoking the command that could start it.

The canary passes only when both fresh runs meet all of these:

- exact requested count `15`;
- at least `14/15` successful profiles and at most one explicit unavailable;
- no schema, auth, quota, rate-limit, transport, unattributed, or duplicate failure;
- at least one of the critical batch's three incomplete rows becomes a successful profile;
- each actual charge is `<= $0.05` and combined actual charge is `<= $0.10`.

- [ ] **Step 6: Run unit tests and a zero-cost dry replay**

```bash
npx vitest run \
  lib/services/analysis/profile-repair-canary-run-store.test.ts \
  lib/services/analysis/profile-repair-canary-run-migration-contract.test.ts \
  lib/services/analysis/profile-repair-canary-run-pglite.test.ts \
  scripts/canary-apify-profile-repair-options.test.ts \
  scripts/canary-apify-profile-repair.test.ts \
  scripts/canary-instagram-provider-options.test.ts \
  lib/services/instagram/providers/apify.test.ts
npm run canary:apify-profile-repair -- \
  --credential-slot primary \
  --source-request-id "$AUTHORIZED_SOURCE_REQUEST_ID" \
  --critical-job-key "track:profiles:batch:7"
```

The script obtains run IDs only from the protected provider ledger and never outputs them. Expected dry result: source replay classifies the known exact 15 and `mode="replay"`; fresh start count remains zero.

- [ ] **Step 7: Correct the stale operations-document inventory statement**

Correct `docs/operations-cost-model.md` from “Basic and Standard combined 15” to “Basic 10 and Standard 10 independently,” and add only a cross-link to that invariant in `docs/groble-earlybird-operations.md`. Do not edit landing-page marketing copy, Groble products, inventory rows, checkout URLs, or prices.

- [ ] **Step 8: Commit, open PR 1, and obtain independent review**

```bash
git add scripts package.json docs/authorized-apify-sharded-e2e-runbook.md \
  lib/services/analysis/profile-repair-canary-run-* \
  supabase/migrations/20260718123000_add_profile_repair_canary_journal.sql \
  docs/operations-cost-model.md docs/groble-earlybird-operations.md
git commit -m "feat: add crash-safe profile repair canary"
git push -u origin feat/apify-profile-repair-canary
gh pr create --fill
```

Request a separate reviewer/subagent to inspect paid-call gating, token redaction, ambiguous-start handling, and documentation consistency. Merge only after CI is green and every actionable finding is resolved.

## Task 2: Execute the Paid Micro-Canary Behind an Approval Stop

This task is an operational gate, not an implied approval.

- [ ] **Step 1: Recheck read-only quota, balance, and isolation**

Immediately before the paid call:

- confirm PR 1 is merged, apply `20260718123000_add_profile_repair_canary_journal.sql` through the normal migration path, and verify its history/RLS/revokes before deploying or invoking the reviewed canary SHA;
- confirm the chosen slot's current balance/credit and exact profile Actor daily run/item limits;
- confirm the two runs plus `$0.10` maximum exposure fit without purchase or token rotation;
- confirm no active V2 request/provider run and no other operator uses that credential;
- confirm the script SHA is the reviewed and merged SHA;
- confirm the unconfirmed replay still selects exactly 15 rows and `track:profiles:batch:7` has exactly three incompletes.

- [ ] **Step 2: Ask for explicit paid-call approval**

Report the selected non-secret slot name, up to `2` intended Actor runs, exact `15` profiles per run, maximum total charge `$0.10`, and stop conditions. State that repetition 2 is forbidden when repetition 1 is ambiguous, failed, or unreconciled. Do not run the command until the user explicitly approves it in that session.

- [ ] **Step 3: Run once and record only the sanitized output**

Use the same source-request and critical-job arguments as the dry replay and add:

```bash
--confirm-paid-api-call
```

Never paste shell history containing tokens. Never add a token inline. The `.env.local` loader or existing secret environment supplies it.

- [ ] **Step 4: Branch on the gate**

- If the gate passes, proceed to Task 3.
- If either repetition fails, stop. If any start is ambiguous, stop all automatic starts, audit the Apify account manually, preserve `cost_status=unknown` until reconciled, and count the reserved ceiling in session exposure. Do not rerun, relax completeness, enlarge the repair cap, switch credentials, or change Actor silently. Apply `systematic-debugging` to the sanitized outcome categories and write a separate provider/egress replacement plan.

## Task 3: Implement a Pure, Bounded Profile Repair Policy

Tasks 3-5 are PR 2 and run in the profile-repair worktree only. After Task 2 passes and `origin/main` contains PR 1, create it from that exact head:

```bash
git worktree add ../ai-baram-detector-profile-repair \
  -b fix/instagram-profile-repair origin/main
```

Use `systematic-debugging` to preserve the observed failure signature and `test-driven-development` for every behavior change.

- [ ] **Step 1: Write the pure policy tests first**

Create `lib/domain/analysis/profile-repair-policy.test.ts` with these cases:

```ts
expect(selectProfileRepairUsernames(batchOf(28, {
    successes: 25,
    incomplete: ['u25', 'u26', 'u27'],
}))).toEqual(['u25', 'u26', 'u27']);

expect(selectProfileRepairUsernames(batchOf(30, {
    successes: 27,
    incomplete: ['u27', 'u28', 'u29'],
}))).toEqual([]); // exactly 90% already passes

expect(() => selectProfileRepairUsernames(batchWithFailure('schema')))
    .toThrow('PROFILE_REPAIR_NOT_ELIGIBLE');
```

Also prove:

- requested order is preserved;
- only fallback `failed/incomplete` rows are selected;
- success and explicit unavailable rows are never selected;
- passing coverage performs no repair;
- one to five incomplete rows below 90% are repairable;
- six or more rows fail closed without a repair;
- duplicate/missing/unexpected outcomes fail validation;
- target evidence with one incomplete profile remains strict and does not use candidate repair.

- [ ] **Step 2: Verify the missing-policy failure**

```bash
npx vitest run lib/domain/analysis/profile-repair-policy.test.ts
```

Expected before implementation: FAIL because the module does not exist.

- [ ] **Step 3: Implement constants and exact selection**

In `profile-repair-policy.ts`:

```ts
export const ANALYSIS_V2_PROFILE_MIN_TERMINAL_RATIO = 0.9;
export const ANALYSIS_V2_PROFILE_REPAIR_MAX_USERNAMES = 5;
```

Compute `minimumTerminal = Math.ceil(requested.length * 0.9)`. Return an immutable ordered subset only when terminal success/unavailable count is below that boundary, every failure is `incomplete`, and the incomplete count is at most five. Never mutate or reinterpret the outcome category.

- [ ] **Step 4: Commit the pure policy**

```bash
git add lib/domain/analysis/profile-repair-policy.ts \
  lib/domain/analysis/profile-repair-policy.test.ts
git commit -m "feat: define bounded profile repair policy"
```

## Task 4: Add a Separate Durable `profile-repair` Provider Operation and Audit Row

- [ ] **Step 1: Write failing operation-kind and migration tests**

Extend the store tests so:

```ts
expect(createAnalysisV2ProviderOperationKey('profile-repair', canonicalInput))
    .toMatch(/^profile-repair:[0-9a-f]{64}$/);
```

The migration contract must require the exact new prefix, preserve the SHA-256 suffix, preserve `SECURITY DEFINER`, fixed `search_path`, RLS, revokes, immutable identity checks, and the existing primary key `(request_id, job_key, operation_key)`.

Add failing store, migration-contract, and PGlite tests for one service-role-only `analysis_v2_profile_repair_audits` row per request/profile job. It contains only bounded numeric aggregates and booleans:

- initial requested/success/unavailable/incomplete/other-failure counts and `initial_exact_fallback_set`;
- repair requested/success/unavailable/incomplete/other-failure counts and `repair_exact_incomplete_subset`;
- final terminal/incomplete counts and capture timestamps.

It stores no usernames, URLs, payloads, provider messages, run/dataset IDs, prompts, captions, tokens, or user-facing content. The fenced RPC accepts the live job claim, writes the initial aggregate exactly once, then permits only the compatible terminal extension. Identical replay is idempotent and conflicting counts fail closed. Anon/authenticated roles have no access.

- [ ] **Step 2: Verify the pre-change failure**

```bash
npx vitest run \
  lib/services/analysis/v2-provider-run-store.test.ts \
  lib/services/analysis/v2-provider-run-migration-contract.test.ts \
  lib/services/analysis/v2-profile-repair-audit-store.test.ts \
  lib/services/analysis/v2-profile-repair-audit-pglite.test.ts
```

Expected before implementation: FAIL because `profile-repair` and the durable initial/repair audit do not exist.

- [ ] **Step 3: Add the TypeScript and forward SQL operation kind**

Add `profile-repair` only to the provider ledger operation union and SQL validator. In the same forward migration, add the narrowly typed repair-audit table and fenced service-role RPCs described above. Do not add a new authorized-test credential field. Repair deliberately resolves the existing `profile-fallback` credential mapping so both runs use the same physical account and no new token surface is created.

- [ ] **Step 4: Refactor binding identity from credential routing**

In `v2-collection-executors.ts`, make the distinction explicit:

```ts
bindApifyRun({
    providerOperation: 'profile-repair',
    credentialOperation: 'profile-fallback',
    operationKey,
    inputHash,
    actorId: PROFILE_ACTOR_ID,
    maxChargeUsd,
});
```

Existing operations pass the same value for both fields. Tests must prove the repair row has a `profile-repair:` operation key while its stored credential slot equals the request-bound `profile-fallback` slot.

- [ ] **Step 5: Commit the ledger migration**

```bash
git add lib/services/analysis/v2-provider-run-store.ts \
  lib/services/analysis/v2-provider-run-store.test.ts \
  lib/services/analysis/v2-provider-run-migration-contract.test.ts \
  lib/services/analysis/v2-profile-repair-audit-* \
  supabase/migrations/20260718130000_add_analysis_v2_profile_repair_operation.sql
git commit -m "feat: ledger profile repair runs and provenance"
```

## Task 5: Implement One Repair Run With Crash-Safe Resume

- [ ] **Step 1: Write the V2 scraper failures first**

Add focused tests to `scraper-v2.test.ts`:

1. `25/28` initial fallback calls the repair binder with exactly the three incomplete usernames.
2. A repair success for one row merges to `26/28`, persists one final fallback snapshot, and passes.
3. Exactly `27/30` performs no repair.
4. Schema/unattributed/duplicate/non-incomplete failure performs no repair and remains failed closed.
5. Six incomplete rows perform no repair.
6. A repair result cannot replace a first-run success or unavailable result with a worse result.
7. A repair barrier error persists no synthetic fallback snapshot.
8. A retry with primary checkpoint + initial provider `resumeRunId` + repair provider `resumeRunId` reads both datasets and starts neither Actor again.
9. Crash after the initial Actor but before repair binding replays the initial dataset and starts exactly one repair.
10. Crash after repair terminalization but before final checkpoint replays both datasets and persists once.
11. Legacy `getProfilesBatch` and target-profile reuse behavior remain unchanged.
12. Initial aggregate persistence failure starts no repair Actor.
13. A crash after initial aggregate persistence resumes from the same initial provider run and does not duplicate the audit row.
14. Terminal aggregate persistence failure writes no merged fallback snapshot; retry reparses journal-owned provider runs, writes the identical final aggregate, and persists once.
15. Terminal evidence can distinguish initial versus repair requested/success/unavailable/incomplete counts after the merged fallback snapshot is the only raw attempt snapshot left.

- [ ] **Step 2: Write executor lifecycle failures first**

In `v2-collection-executors.test.ts`, assert:

- initial canonical input is `profile-fallback-v2 + frozen unresolved`;
- repair canonical input is separately domain-separated as `profile-repair-v1 + exact incomplete subset`;
- the repair budget is `count * APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD`, capped at five rows (`$0.013` at the current estimate);
- initial and repair operation keys differ and both resume their own stored run IDs;
- final fallback checkpoint is written only after both required runs are terminal;
- final batch still rejects `25/28` if repair recovers zero;
- target evidence does not bind `profile-repair`;
- provider cleanup discovers and settles both operations after failure.

- [ ] **Step 3: Verify the tests fail for the right reason**

```bash
npx vitest run \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/analysis/v2-collection-executors.test.ts
```

Expected before implementation: FAIL because there is only one paid V2 profile run.

- [ ] **Step 4: Extend the V2 options without changing legacy routing**

Add a lazy binder to `ProfilesBatchV2Options`:

```ts
bindRepairProviderRun?: (
    exactIncompleteUsernames: readonly string[]
) => Promise<ProviderRunCheckpoint>;
```

Keep `providerRun` as the initial fallback checkpoint. Do not raise `MAX_PAID_FALLBACKS` and do not route any legacy caller through repair.

- [ ] **Step 5: Run, merge, and persist in the correct order**

Inside `getProfilesBatchV2`:

1. persist primary self-hosted outcomes;
2. run/resume initial Apify fallback on the frozen exact unresolved list;
3. parse and validate the initial dataset, then durably persist its PII-free audit aggregate before any repair binding;
4. call the pure policy;
5. if eligible, lazily bind and run/resume one Apify repair on only that list;
6. merge by requested username, allowing repair `success` or explicit `unavailable` to replace an initial `incomplete`; never overwrite a better row;
7. validate one terminal outcome per original fallback username and durably extend the audit with the repair/final aggregate (`repair requested=0` when no repair is eligible);
8. only after the audit barrier succeeds, persist one merged `attempt='fallback'` snapshot;
9. return the existing final result shape plus optional immutable repair diagnostics if needed by tests.

Any paid-run or repair-audit barrier throws before final fallback persistence, allowing the same provider-ledger run IDs to be replayed safely. If initial audit persistence is ambiguous, do not bind or start repair. If terminal audit persistence is ambiguous, replay the durable runs and idempotently reconcile it before writing the merged snapshot.

- [ ] **Step 6: Run focused tests and commit**

```bash
npx vitest run \
  lib/domain/analysis/profile-repair-policy.test.ts \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/analysis/v2-collection-executors.test.ts \
  lib/services/analysis/v2-profile-repair-audit-store.test.ts \
  lib/services/analysis/v2-profile-repair-audit-pglite.test.ts \
  lib/services/analysis/v2-provider-lifecycle.test.ts
git add lib/services/instagram/scraper.ts \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/analysis/v2-collection-executors.ts \
  lib/services/analysis/v2-collection-executors.test.ts \
  lib/services/analysis/v2-profile-repair-audit-* \
  docs/analysis-v2-provider-lifecycle-runbook.md \
  docs/operations-cost-model.md
git commit -m "fix: repair exact incomplete profile evidence"
```

## Task 6: Remove Cross-Credential Serialization Without Widening Other Actors

This is independent PR 3. After PR 1 merges, create its worktree from current `origin/main`; it may be reviewed while Task 2 is pending, but must not be deployed/enabled unless the micro-canary passes.

```bash
git worktree add ../ai-baram-detector-actor-concurrency \
  -b perf/apify-slot-concurrency origin/main
```

- [ ] **Step 1: Lock the current semaphore bug with controlled promises**

In `apify.test.ts`, use deferred promises and assert:

```ts
const primary = runWithApifyActorCapacity(
    capacity('primary', 'profile', 1, 1),
    holdPrimary
);
const secondary = runWithApifyActorCapacity(
    capacity('secondary', 'profile', 1, 1),
    holdSecondary
);
await expect(secondaryStarted).resolves.toBe(true);
```

Also prove all mixed-operation cases on one physical slot:

- eight profile tasks may run, while the ninth waits;
- relationship plus interaction together never exceed the shared non-profile cap of two;
- profile and non-profile work together never exceed the account cap of eight;
- constructing non-profile capacity first cannot pin later profile work to two, and constructing profile capacity first cannot widen non-profile work to eight;
- rejected tasks release both class and account permits.

In `apify-interactions.test.ts`, set the runtime default slot differently from `context.credentialSlot` and prove the persisted context slot controls semaphore selection. Add configuration tests proving `APIFY_PROFILE_ACTOR_CONCURRENCY=8` affects only profile Actor calls while relationship and interaction calls remain at their existing `APIFY_ACTOR_CONCURRENCY` value.

- [ ] **Step 2: Verify the cross-slot test fails before the fix**

```bash
npx vitest run \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/apify-interactions.test.ts
```

Expected before implementation: FAIL because the capacity API does not exist; a minimal characterization using the old helper separately confirms the secondary slot waits behind the primary because there is one global semaphore.

- [ ] **Step 3: Key semaphores by the effective credential slot**

Replace the single create-first-wins semaphore with two deterministic layers:

```ts
runWithApifyActorCapacity(
    capacity: {
        credentialSlot: ApifyCredentialSlot;
        operationClass: 'profile' | 'non_profile';
        accountConcurrency: number;
        classConcurrency: number;
    },
    task: () => Promise<T>
): Promise<T>
```

Use `context?.credentialSlot ?? configuredCredentialSlot` at every profile, relationship, and interaction call site. Acquire the narrower class permit before the account permit so a class wait cannot occupy account capacity. Store one account semaphore per known physical slot and one class semaphore per `(slot,class)` with immutable config-derived limits; reject conflicting reconstruction. Never use a token/token hash as a key or log the key with provider payloads.

Add `APIFY_PROFILE_ACTOR_CONCURRENCY` with allowed range `1..10` and a default inherited from the existing `APIFY_ACTOR_CONCURRENCY` value (`2` when neither is set). Keep relationship and interaction together on the non-profile `APIFY_ACTOR_CONCURRENCY` cap of two. For each slot, derive the account cap deterministically as the maximum of the two configured class caps, bounded by the live Apify account limit. The authorized worker may set the profile class/account cap to eight only after the micro-canary and live-limit gates; this removes profile waves without widening relationship/interaction work.

- [ ] **Step 4: Run the provider suite and commit**

```bash
npx vitest run \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/apify-interactions.test.ts \
  lib/services/instagram/providers/coderx.test.ts
git add lib/services/instagram/providers/apify-relationship.ts \
  lib/services/instagram/providers/apify.ts \
  lib/services/instagram/providers/apify-interactions.ts \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/apify-interactions.test.ts \
  docs/authorized-apify-sharded-e2e-runbook.md
git commit -m "perf: isolate actor concurrency by credential slot"
```

## Task 7: Preserve PII-Free Launch Evidence Before Cleanup

Tasks 7-8 are PR 4. Only after PR 2 merges, create the launch-evidence worktree from the new `origin/main`:

```bash
git worktree add ../ai-baram-detector-launch-evidence \
  -b feat/analysis-v2-launch-evidence origin/main
```

The final result cleanup must continue deleting raw profiles, usernames, captions, URLs, and media artifacts. Preserve only bounded numeric evidence needed to evaluate the run.

- [ ] **Step 1: Write migration security and capture tests first**

The new table/RPC in `20260718143000_add_analysis_v2_launch_evidence.sql` must be service-role-only, forced RLS, and contain no text capable of holding usernames, captions, URLs, prompts, run IDs, dataset IDs, claim tokens, or raw errors. Add a service-only `analysis_requests.launch_evidence_status` constrained to `pending|captured|missing|conflicted`; it is the durable fail-closed marker and is not added to authenticated/client select grants.

Make this a genuinely forward-compatible migration rather than assuming empty tables. Add `launch_evidence_status` nullable with no default: every pre-migration request remains `NULL`, no historical result is rewritten or claimed as captured, and readiness treats `NULL` as a legacy-missing blocker. Only the replaced terminalization functions may move a request through the four non-null states. For profile outcomes, introduce an explicit telemetry schema version. Existing rows become version 1; cache/fallback origins are safely derivable as `not_applicable`, legacy self-hosted origin remains `NULL`, and its latency bucket is derived only from the row's exact `latency_ms`. New writes are version 2 and must have one non-null exact origin plus one derived fixed bucket. A check may permit `NULL` origin only for version-1 self-hosted rows; it must never label an old pre-network gate/circuit outcome as a network attempt.

Existing aggregate telemetry that no longer has raw outcome rows cannot be repartitioned from total/max values. Mark those aggregates version 1, put their full count in a bounded `legacy_unattributed_count`, and leave all newly added origin/histogram counters at zero; never synthesize a histogram. Version-2 capture writes exact origin counters, fixed buckets, and `legacy_unattributed_count=0`. The final-run readiness gate requires version 2, a zero legacy-unattributed count, and exact count partitions, so legacy compatibility cannot create false launch evidence.

The same migration extends collection-time profile outcome/telemetry storage with a strict origin (`network|global_gate|circuit|not_applicable`) and fixed latency bucket (`le_1s|le_5s|le_15s|le_60s|gt_60s`). For version-2 rows, cross-field checks require self-hosted outcomes to use the first three and cache/fallback outcomes to use `not_applicable`. A positive request-start callback always yields `network`; otherwise exported typed provider errors distinguish `global_gate` from `circuit`. The terminalizer only aggregates this durable telemetry and never infers origin from a generic category or arbitrary message after the fact.

One row per request stores bounded structures for:

- per profile batch: requested, primary successes, self-hosted attempt count, network-start count, global-gate timeout/denial count, circuit-open count, failures by safe category/HTTP-status bucket, bounded latency sample/count/sum/max plus fixed histogram buckets, and the initial/repair/final aggregates copied from the durable repair-audit row, including both exact-set booleans;
- authorization: one hashed entitlement-JTI consumption, reciprocal preflight/request identity, and zero sibling preflight/request count; the hash itself is never copied to launch evidence or output;
- exclusion: explicit decision applied plus excluded-identity occurrence counts for relationship freeze, profile batches, AI candidate inputs, shortlist, reverse interactions, and final result; only numeric counts/booleans survive and every occurrence must be zero;
- media totals: public profiles with posts, reels, reels with thumbnail, carousels, declared/collected carousel slides, slides with captions, generated bundles, bundle items, bundle bytes, triage/feature/partner/narrative Gemini media items;
- interactions: target liker/comment returned counts and coverage, reverse-like candidates by `observed/not_observed/not_collected`;
- result: risk-policy version, female/private result counts, risk-band counts, recent-mutual badge count, narrative count;
- cleanup: captured-before-purge boolean and artifact count at terminalization. The readiness query separately requires the current active-artifact count to reach zero after cleanup.

PGlite tests must complete one synthetic request, crash/replay each typed self-hosted origin through checkpoint telemetry, prove all counts are captured before raw staging deletion, then prove the long-term row contains none of the fixture usernames/captions/URLs. Separate failure injections must prove:

- unavailable evidence capture sets durable status `missing` while result completion, DB PII purge, and subsequent artifact cleanup continue;
- a conflicting replay sets sticky `conflicted` outside the rolled-back capture subtransaction, cannot return to `captured`, and blocks readiness;
- an identical replay remains `captured` and idempotent;
- double-click/crash replay of one entitlement JTI produces one request, zero siblings, and one cost/readiness subject.

Before the new-schema tests, an upgrade PGlite test must build the immediately previous schema, insert representative processing/failed/completed requests plus cache, fallback, and self-hosted profile outcomes and an aggregate-only telemetry row, and then apply the forward migration. It must prove the migration succeeds without changing request/result status or grants; legacy requests retain `launch_evidence_status=NULL`; only derivable legacy origins/buckets are filled; an aggregate-only row remains explicitly unattributed; and new version-2 inserts reject missing/invalid origins or inconsistent buckets. Reapplying terminalization to a legacy terminal fixture may only remain legacy or fail closed as `missing`; it must never become `captured` from invented evidence.

The same PR hardens the operator confirmation boundary. Both `test-admission:issue` and `test-entitlement:issue` must parse an exact, valueless `--confirm-paid-api-call` flag and emit no token without it. The signed payload carries a required confirmation claim, so a hand-built legacy/unconfirmed token is rejected by intake. CLI, route, and PGlite tests cover the whole absence path and assert zero created preflights, zero requests, zero provider reservations/starts, and zero queue dispatches. The flag is still insufficient by itself: the operator must also have the fresh explicit approval recorded in the executing session.

- [ ] **Step 2: Verify the missing migration failure**

```bash
npx vitest run \
  lib/domain/analysis/profile-fetch-outcome.test.ts \
  lib/services/instagram/providers/profile-attempt.test.ts \
  lib/services/instagram/providers/selfhosted/global-request-gate.test.ts \
  lib/services/instagram/providers/selfhosted/web-client.test.ts \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/test-entitlement-consumption.test.ts \
  lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts \
  lib/services/analysis/test-entitlement.test.ts \
  scripts/issue-analysis-test-admission.test.ts \
  scripts/issue-analysis-test-entitlement.test.ts \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/test-entitlement-route.test.ts \
  lib/services/analysis/v2-launch-evidence-migration-contract.test.ts \
  lib/services/analysis/v2-launch-evidence-pglite.test.ts \
  lib/services/analysis/v2-launch-evidence-upgrade-pglite.test.ts
```

Expected before implementation: FAIL because the migration and tests do not exist.

- [ ] **Step 3: Capture atomically in terminal paths**

Extend both `complete_analysis_v2_result_and_purge` and `fail_analysis_v2_result_and_purge` through a forward migration. Set `launch_evidence_status='pending'` on the request, then before purge attempt to build the PII-free row from existing collection telemetry/checkpoint/result/repair-audit tables in an exception-isolated SQL block. On identical success set `captured`; in the outer exception handler set `missing` for unavailable capture or sticky `conflicted` for an immutable-value mismatch. Then always execute the authoritative result terminalization and raw working-data purge. Never keep raw material just to aid QA.

Launch evidence is diagnostic, not part of the user-result transaction contract: `missing|conflicted` must not roll back a completed result, retain DB PII, or prevent the post-terminal artifact-cleanup worker from running. On request failure, capture best available counts with `completed=false` when possible. Replays must upsert the same deterministic counts; a conflict rolls back only the inner capture block and then persists the outer request marker. The readiness evaluator requires both an evidence row and `launch_evidence_status='captured'`, so a stale earlier row can never false-pass after a conflicting replay.

- [ ] **Step 4: Add a strict readiness schema and evaluator**

`v2-launch-readiness.ts` loads existing operational observability plus the new evidence row and returns:

```ts
type LaunchReadinessDecision = {
    passed: boolean;
    outcome: 'SUCCESS' | 'FAILED' | 'BEHAVIOR_SUCCESS_COST_BLOCKED';
    blockers: readonly LaunchReadinessBlockerCode[];
    timing: {
        queueMs: number;
        relationshipsAndTargetMs: number;
        profileAndAiMs: number;
        shortlistAndReverseMs: number;
        narrativeAndFinalizeMs: number;
        wallMs: number;
    };
    coverage: Record<string, number | boolean>;
    costs: {
        preflightApifyActualUsd: number;
        requestApifyActualUsd: number;
        geminiModeledUsd: number;
        geminiMissingUsageCount: number;
        gcpInfrastructureListPriceUsd: number | null;
        productUnitModeledUsd: number;
        billingActualUsd: number | null;
        microCanarySessionUsd: number | null;
        sessionModeledUsd: number;
    };
};
```

Add a service-role-only readiness snapshot RPC rather than using a date-range acquisition aggregate. The loader must join `analysis_requests.preflight_id` to its `analysis_preflights` row and every `analysis_preflight_provider_runs` row, require the reciprocal `analysis_preflights.consumed_request_id` to equal the request, then join the request-scoped provider and AI ledgers. Require every preflight and request provider operation and cleanup intent to be terminal and cost-reconciled; do not treat the request-only operational aggregate as the whole acquisition cost. Define `windowStartAt=analysis_preflights.created_at` and `workloadSettledAt=max(request terminal/PII scrub, every provider reconciliation, every artifact deleted_at)`. If any required row is active/unreconciled or any artifact remains, `workloadSettledAt` is null and readiness blocks.

The modeled product-unit cost includes preflight Apify actual, request Apify actual, token-complete Gemini modeled cost, and GCP infrastructure metering-times-list-price. The billed-actual product cost instead combines Apify actual with isolated Vertex/Gemini and Cloud Run/Tasks billing actuals; it must not add the Gemini modeled value a second time. Micro-canary spend is reported separately as session R&D spend and added only to the session total, never to the product unit cost.

The pure evaluator blocks on:

- request not completed, missing result/evidence, any active/unreconciled preflight or request provider row, reserved AI attempt, pending/processing/failed/cancelled job, or remaining queue/artifact;
- entitlement consumption is not exactly one, reciprocal preflight/request/JTI ownership fails, any sibling request/preflight used the authorization, exclusion decision was not applied, or the excluded identity appears in any downstream-stage count;
- wall `>=280,000ms`;
- relationship/target lane `>60,000ms`, profile+AI lane `>150,000ms`, shortlist/reverse lane `>45,000ms`, or narrative/finalize lane `>40,000ms`;
- incomplete relationship counts, profile batch below 90%, false exact-set invariants, or repair size above five;
- self-hosted attempts not partitioning exactly into pre-network gate/circuit outcomes plus network starts, invalid latency histograms, or an initial fallback requested count/set that differs from the self-hosted unresolved terminal set;
- reel thumbnail coverage below 100%, collected carousel slides differing from declared bounded slides, slide-caption alignment failure, or any Gemini media count above stage policy;
- missing target interaction operations or inconsistent final risk-policy version;
- `costComplete=false`, `aiMissingUsageCount>0`, absent GCP metering evidence, or an evidence window that does not cover preflight start through terminal cleanup.

Queue/fanout duration is always reported as a diagnostic, but it is not a standalone launch blocker because the previous measured queue/fanout span was about `41s`; the hard end-to-end wall and named execution-lane budgets remain the gates. If wall time fails, apply systematic debugging to queue/fanout rather than inventing a post-hoc `20s` threshold.

Cloud Run/Tasks cost is injected from the GCP measurement step; the script must not pretend the existing Supabase observability value includes it. `v2-gcp-cost-evidence.ts` accepts a JSON document bound to the request UUID, exact deployed SHA/revision, service/region, USD currency, window start/end, Cloud Run request/vCPU/GiB/network metering and list-price cost, Cloud Tasks operations/retries/pending count and cost, SKU price timestamp, and measured idle baseline. Its window must begin no later than `windowStartAt` and end no earlier than `workloadSettledAt`; exact task pending count must be zero. Reject a mismatched request/revision, malformed or negative meter, missing price timestamp, or file whose real path is inside the repository. A separate optional billing-evidence document may add isolated Vertex/Cloud Run/Tasks billed actuals; delayed billing remains explicitly null rather than being copied from list-price estimates.

- [ ] **Step 5: Implement a sanitized report command**

`report-analysis-v2-launch-readiness.ts` accepts `--request-id`, required `--gcp-evidence-file`, optional `--billing-evidence-file`, and `--microcanary-source-request-id` for the fixed canary version used in this session. It loads service-role data and outputs only the decision above. It must reject V1 requests and never output usernames, prompts, captions, URLs, provider run IDs, dataset IDs, tokens, hashes, claim/fence values, or evidence-file paths. Missing GCP evidence is a readiness blocker. Missing delayed billing evidence yields `BEHAVIOR_SUCCESS_COST_BLOCKED`, not a fabricated billed actual. The selected canary journal must contain both intended terminal/reconciled repetitions before an exact session-spend total is reported; an ambiguous repetition retains unknown session spend and blocks that exact total.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run \
  lib/domain/analysis/profile-fetch-outcome.test.ts \
  lib/services/instagram/providers/profile-attempt.test.ts \
  lib/services/instagram/providers/selfhosted/global-request-gate.test.ts \
  lib/services/instagram/providers/selfhosted/web-client.test.ts \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/test-entitlement-consumption.test.ts \
  lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts \
  lib/services/analysis/test-entitlement.test.ts \
  scripts/issue-analysis-test-admission.test.ts \
  scripts/issue-analysis-test-entitlement.test.ts \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/test-entitlement-route.test.ts \
  lib/services/analysis/v2-launch-evidence-migration-contract.test.ts \
  lib/services/analysis/v2-launch-evidence-pglite.test.ts \
  lib/services/analysis/v2-launch-evidence-upgrade-pglite.test.ts \
  lib/services/analysis/v2-launch-readiness.test.ts \
  lib/services/analysis/v2-gcp-cost-evidence.test.ts \
  lib/services/analysis/v2-operational-observability-migration-contract.test.ts
git add supabase/migrations/20260718143000_add_analysis_v2_launch_evidence.sql \
  lib/domain/analysis/profile-fetch-outcome.ts \
  lib/domain/analysis/profile-fetch-outcome.test.ts \
  lib/services/instagram/providers/profile-attempt.ts \
  lib/services/instagram/providers/profile-attempt.test.ts \
  lib/services/instagram/providers/selfhosted/global-request-gate.ts \
  lib/services/instagram/providers/selfhosted/global-request-gate.test.ts \
  lib/services/instagram/providers/selfhosted/web-client.ts \
  lib/services/instagram/providers/selfhosted/web-client.test.ts \
  lib/services/instagram/scraper.ts \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/analysis/v2-profile-fetch-store.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/test-entitlement-consumption.test.ts \
  lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts \
  lib/services/analysis/test-entitlement.ts \
  lib/services/analysis/test-entitlement.test.ts \
  scripts/issue-analysis-test-admission.ts \
  scripts/issue-analysis-test-admission.test.ts \
  scripts/issue-analysis-test-entitlement.ts \
  scripts/issue-analysis-test-entitlement.test.ts \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/test-entitlement-route.test.ts \
  lib/services/analysis/v2-launch-evidence-* \
  lib/services/analysis/v2-launch-readiness.ts \
  lib/services/analysis/v2-launch-readiness.test.ts \
  lib/services/analysis/v2-gcp-cost-evidence.ts \
  lib/services/analysis/v2-gcp-cost-evidence.test.ts \
  scripts/report-analysis-v2-launch-readiness.ts package.json \
  docs/authorized-apify-sharded-e2e-runbook.md \
  docs/operations-cost-model.md
git commit -m "feat: report v2 launch readiness evidence"
```

## Task 8: Make Unknown Gemini Usage Visible Without Calling It Exact

This task does not fabricate token usage and does not add a second generation call.

- [ ] **Step 1: Add failing readiness/cost tests**

Prove:

- one `usageMetadataStatus='missing'` keeps `costComplete=false`;
- `totalKnownUsd` excludes the unknown call and is labeled a lower bound;
- an optional conservative upper bound, if added, is stored and reported separately from estimated/actual cost;
- no report serializes a missing call as zero tokens or `$0`;
- a run cannot satisfy the exact-cost launch gate with missing or malformed usage.

- [ ] **Step 2: Preserve the current durable telemetry semantics**

Do not call `countTokens` for every request and do not change stage models, thinking levels, retries, media limits, or output-token limits. If implementation adds a missing-usage upper bound, compute it only from reviewed bounded inputs/model policy and name it `conservativeUpperBoundUsd`; never add it to `geminiEstimatedUsd` or describe it as actual.

- [ ] **Step 3: Verify and commit any required schema/report changes**

Run the AI attempt/result-store and readiness suites. If the existing `aiMissingUsageCount` plus lower-bound labeling is sufficient, make no production schema change in this task.

## Task 9: Run Full Regression, Independent Review, and Merge PRs 2-4 Separately

- [ ] **Step 1: Run focused launch-pipeline tests**

```bash
npx vitest run \
  lib/domain/analysis/profile-repair-policy.test.ts \
  lib/services/instagram/scraper-v2.test.ts \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/apify-interactions.test.ts \
  lib/services/instagram/providers/profile-attempt.test.ts \
  lib/services/instagram/providers/selfhosted/global-request-gate.test.ts \
  lib/services/instagram/providers/selfhosted/web-client.test.ts \
  lib/domain/analysis/profile-fetch-outcome.test.ts \
  lib/services/analysis/v2-collection-executors.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/v2-provider-run-store.test.ts \
  lib/services/analysis/v2-provider-run-migration-contract.test.ts \
  lib/services/analysis/v2-profile-repair-audit-store.test.ts \
  lib/services/analysis/v2-profile-repair-audit-pglite.test.ts \
  lib/services/analysis/v2-provider-lifecycle.test.ts \
  lib/services/analysis/v2-launch-readiness.test.ts \
  lib/services/analysis/v2-gcp-cost-evidence.test.ts \
  lib/services/analysis/test-entitlement-consumption.test.ts \
  lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts
```

- [ ] **Step 2: Run carousel, scoring, mobile-result, and early-bird regressions**

```bash
npx vitest run \
  lib/domain/analysis/carousel-caption-policy.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-result-store.test.ts \
  lib/services/analysis/v2-result-route.test.ts \
  lib/services/earlybird
```

Expected early-bird evidence: the QA `payment_pending` contract still creates no paid sequence/result and consumes no inventory. The diff must contain no `app/api/earlybird/**`, checkout URL, price, product, or inventory mutation.

- [ ] **Step 3: Run repository-wide verification**

```bash
npm test
npm run lint
npm run build
git diff --check origin/main...HEAD
git status --short
```

- [ ] **Step 4: Open separate PRs and request separate independent reviews**

```bash
# PR 2 worktree
git push -u origin fix/instagram-profile-repair
gh pr create --fill

# PR 3 worktree
git push -u origin perf/apify-slot-concurrency
gh pr create --fill

# PR 4 worktree, after rebasing on merged PR 2
git push -u origin feat/analysis-v2-launch-evidence
gh pr create --fill
```

Each PR description includes the exact RED command/failure, the minimal GREEN change, the focused passing command, and the full regression result. A test that passed before implementation is not accepted as TDD evidence; correct or replace it before production code is kept.

The independent reviewer must explicitly inspect:

- exact fallback and repair subsets;
- typed self-hosted network/global-gate/circuit attribution and latency buckets;
- one-entitlement/one-request uniqueness and per-stage exclusion-zero evidence;
- durable run reservation/start/terminal ordering and crash replay;
- schema contamination fail-closed behavior;
- per-slot semaphore release and effective-slot selection;
- SQL RLS, service-role revokes, fences, cleanup ordering, and PII absence;
- cost ceilings and missing-usage labeling;
- unchanged Groble checkout/webhook/inventory/order isolation.

Resolve findings with `receiving-code-review`, rerun each PR's focused tests and CI, and merge each PR independently. Merge PR 2 before the final PR 4 rebase; PR 3 may merge independently. After all three land, run the full integration suite once on `main`. Do not self-approve or bundle the branches into one review.

## Task 10: Deploy the Reviewed Repair and Verify the Production Boundary

- [ ] **Step 1: Apply migrations in normal order**

Apply the remaining reviewed PR 2 and PR 4 forward migrations in normal order without `--include-all` (the PR 1 canary-journal migration was already applied before Task 2). Verify migration history, functions, RLS, revokes, and PGlite contracts before application deployment.

- [ ] **Step 2: Deploy one reviewed SHA**

Deploy the merged commit to Vercel and Cloud Run. Set `APIFY_PROFILE_ACTOR_CONCURRENCY=8` only on the controlled analysis worker after the micro-canary gate; keep `APIFY_ACTOR_CONCURRENCY=2` for relationship and interaction work. Keep:

- max instances `1`;
- container concurrency `8`;
- queue max concurrent dispatches `8`;
- public V2 admission false;
- one Cloud Run revision at 100%, no traffic tag;
- existing self-hosted global gate/circuit settings unchanged.

- [ ] **Step 3: Verify deployed identity and zero active work**

Confirm Vercel and Cloud Run expose the same merged SHA, production returns HTTP 200, no old revision handles work, and all queues/ledgers/jobs are empty.

- [ ] **Step 4: Recheck early-bird state after deployment**

Read-only verify:

- QA Standard remains `payment_pending`;
- no payment, paid, due, sequence, analysis request, or result row appeared;
- Basic and Standard sold/reserved/remaining counters differ from the pre-deploy baseline only by independently verified legitimate external sales; the QA flow contributes a delta of zero;
- Plus creates only a waitlist request.

No checkout completion or real payment is part of this verification.

## Task 11: Prepare and Run One Final Authorized E2E

- [ ] **Step 1: Build a fresh operation-slot budget map**

Immediately re-read balances, exact Actor quotas, recent UTC-day runs, and active secret references. Use the runbook's constraints:

- followers and following on distinct physical accounts;
- initial profile fallback and repair on the same profile account;
- target likers and candidate likers on distinct accounts;
- target comments on a slot with enough bounded headroom;
- no credential rotation, purchase, or automatic failover.

Do not reuse the planning-time balances as authority. Account credit does not prove an individual Actor's daily API quota.

For each selected physical Apify account, query the live [`GET /v2/users/me/limits`](https://docs.apify.com/api/v2/users-me-limits-get) endpoint through the existing secret-backed client and record only sanitized limit/usage counts. Also inspect the selected Actor's current daily run/item quota and recent UTC-day usage. The documented public default is context only; the live account response and Actor-specific headroom decide whether concurrency eight is allowed.

- [ ] **Step 2: Compute conservative maximum exposure before asking approval**

Include:

- the maximum initial plus fresh target-profile fallback allowed by policy;
- the Standard policy maxima for complete followers and following (`800` each), not the stale counts from the prior failed request;
- the Standard detailed-profile maximum (`600`) for initial profile fallback plus `ceil(600 / configuredProfileBatchSize) * MAX_PROFILE_REPAIR_ROWS` repair items (currently five per eligible batch), not the prior observed public count;
- target likers up to `600`, comments up to `90`;
- candidate reverse likers up to `10 x 100`;
- all configured Gemini stage maxima;
- Cloud Run/Tasks list-price maximum for one request.

Resolve every maximum from reviewed runtime constants and print the derived counts/cost ceiling before approval. If a fresh declared relationship count exceeds the reviewed plan maximum, stop rather than truncate it while claiming completeness. If any slot cannot cover its full bounded operation, stop. Do not spread one logical operation across credentials or rely on the earlier run's `238` public profiles.

- [ ] **Step 3: Ask for one explicit E2E paid-call approval**

Present the non-secret operation map, maximum provider exposure, expected Gemini/GCP exposure, and the fact that no real Groble payment will occur. Approval for the micro-canary does not carry over to this full run.

- [ ] **Step 4: Issue flag-confirmed signed admission/entitlement tokens and start while authenticated**

Verify the active Supabase session against the operator-only owner references. In the same executing session as the fresh approval, mint the admission token only with the reviewed CLI interlock:

```bash
npm run test-admission:issue -- \
  --user "$AUTHORIZED_E2E_OWNER_ID" \
  --target "0_min._.00" \
  --idempotency-key "$AUTHORIZED_E2E_IDEMPOTENCY_KEY" \
  --confirm-paid-api-call
```

Capture the signed value only through the operator-only ephemeral mechanism described by the runbook; do not paste it into logs or evidence. Start/resume the single bound preflight, then mint the one-time request entitlement with the same mandatory interlock:

```bash
npm run test-entitlement:issue -- \
  --preflight "$PREFLIGHT_ID" \
  --user "$AUTHORIZED_E2E_OWNER_ID" \
  --plan standard \
  --confirm-paid-api-call
```

Without either flag the CLI must exit before token emission, and the tested intake boundary must leave preflight, request, provider reservation/start, and queue-dispatch counts at zero. A flag from the earlier micro-canary, a previous shell session, or only one of these two commands does not carry over.

Enter `0_min._.00`, select Standard, make the explicit girlfriend-exclusion decision, and submit with the fresh signed values while authenticated. The database must atomically map the entitlement JTI to exactly one preflight/request; UI double-click, HTTP replay, and a crash after consumption must return/resume the same request rather than create a sibling. Before monitoring paid work, query only safe counts and require one consumption, one reciprocal preflight/request, and zero siblings. Record the progress URL/request UUID only in operator evidence, not in committed docs or public output.

- [ ] **Step 5: Prove background/mobile continuation**

After the request is accepted:

1. record current progress;
2. navigate away or close the mobile tab;
3. wait while Cloud Tasks/Run continues without the browser;
4. return as the same user through `/history`;
5. reopen the same request/result.

Do not cancel a healthy request merely because the browser leaves.

- [ ] **Step 6: Monitor stage walls without intervening**

Record timestamps for:

- preflight/fresh admission;
- queue/fanout;
- relationships and target evidence;
- primary self-hosted profile attempts;
- initial Apify profile fallback;
- optional repair;
- private names, gender triage, feature analysis;
- target interaction, shortlist, reverse likes, partner safety, narrative;
- final score/result and cleanup.

Do not rerun a stage manually. Durable retry owns recovery.

- [ ] **Step 7: Run browser result QA**

Use `browse` or `playwright` against `https://yeosachin.vercel.app` on a mobile viewport. Verify:

- result loads from history after navigation away;
- follower/following/mutual/public/private numbers match readiness evidence;
- private accounts are in the documented name-sort order;
- recent mutual women receive the badge and unrelated rows do not;
- the operator-selected girlfriend exclusion is absent from every visible downstream list, while the internal PII-free evidence reports zero occurrences at every stage;
- female risk scores/bands/order match the persisted V2 result contract;
- interaction-derived UI copy does not expose prohibited raw metrics or make definitive relationship accusations;
- profile images use signed image proxy paths and broken images have safe fallback;
- pagination/cursors do not duplicate or omit rows.

The internal launch-evidence report, not public UI, verifies raw reel/carousel/slide-caption counts.

- [ ] **Step 8: Reconcile provider and Gemini costs**

After every Actor's provider accounting settles:

- sum actual preflight + request provider operations, including `profile-repair` separately;
- require zero active/unreconciled provider rows;
- group Gemini by stage/model/thinking and report calls, retries, tokens, latency, and estimated cost;
- require `aiMissingUsageCount=0` to declare the token-priced Gemini estimate complete;
- if usage is missing, report a lower bound/upper bound, mark the cost goal blocked, and do not call the E2E launch-ready;
- when the isolated Cloud Billing export becomes available, reconcile Vertex AI SKU actual against the token-priced estimate. Until then, label it as a complete modeled estimate, not billed actual.

- [ ] **Step 9: Measure Cloud Run and Cloud Tasks cost**

For the exact evidence window, beginning no later than preflight creation/earliest provider reservation and ending after result terminalization and last artifact cleanup, collect:

- Cloud Run billed instance/vCPU seconds and GiB seconds;
- request count/network charge if applicable;
- Cloud Tasks API operations/retries;
- current region/SKU list prices and currency conversion timestamp if reporting KRW.

Write the request/revision-bound evidence to a temporary operator-only JSON file outside the repository. Subtract a measured idle baseline for the same revision/window when needed. Keep GCP infrastructure cost separate from the Apify/Gemini total, then report the combined modeled/list-price product unit cost.

When the Cloud Billing export for the isolated run window arrives, reconcile Vertex AI and Cloud Run/Tasks SKU actuals against the immediate metering-times-list-price estimates. If billing data is delayed, report `BEHAVIOR_SUCCESS_COST_BLOCKED` and keep the cost-confirmation goal open rather than presenting list-price estimates as billed actuals.

- [ ] **Step 10: Run the readiness report and teardown**

```bash
npm run report:analysis-v2-readiness -- \
  --request-id "$REQUEST_ID" \
  --gcp-evidence-file "$GCP_EVIDENCE_FILE" \
  --microcanary-source-request-id "$AUTHORIZED_SOURCE_REQUEST_ID"
```

When isolated billing evidence is available, add `--billing-evidence-file "$BILLING_EVIDENCE_FILE"`. Final success requires `passed=true`, wall `<280000`, complete modeled and billed-actual cost labels, and all exact-set/media/interaction/cleanup invariants true. Before billing evidence arrives, a behaviorally complete run reports `BEHAVIOR_SUCCESS_COST_BLOCKED`; it must not be promoted to exact-cost success.

Then:

- disable authorized-test sharding;
- remove temporary non-selected worker secret references only after no policy-bound request is active;
- retain public admission false;
- confirm queues, active provider runs, processing jobs, and media artifacts are zero;
- save a checkpoint containing the result URL, timing/cost table, counts, PRs, deployed SHAs, and remaining blockers.

## Task 12: Implement the Distributed Gemini Lease Before Automatic Launch

**Follow-up stop boundary:** Tasks 12-13 document the blockers after the authorized one-off E2E. They are not authorized for implementation, deployment, payment, or admission by this plan. After the E2E report, create a fresh worktree and execute PR 5 only with a new user decision.

The installed `@google/genai` [`GenerateContentConfig`](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html) and [`HttpOptions`](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html) support `httpOptions.timeout` in milliseconds and send both a client abort and `X-Server-Timeout`. The documented `abortSignal` contract explicitly does not guarantee cancellation of service-side work, so an ambiguous call can never free capacity merely because its local timer or lease expired.

- [ ] **Step 1: Write the SQL contract and PGlite concurrency failures**

The migration creates exactly eight fixed slots, matching the controlled worker's max concurrent dispatches and container concurrency. Lower the process-shared cap from ten to eight in the same reviewed policy change; automatic launch must re-prove the five-minute objective at this safer cap. Each lease contains:

- slot `1..8`;
- monotonically increasing fence;
- random lease token;
- request/job/operation/attempt and live job claim identity;
- acquired/expiry timestamps;
- state `free|acquired|reserved|quarantined` plus an immutable last-terminal fence;
- no prompt, media, username, result, or provider credential.

RPC tests must prove:

1. eight acquisitions from independent store instances succeed and the ninth does not;
2. releasing one permits exactly one new acquisition with a higher fence;
3. stale token/fence/claim release returns false and cannot clear a newer holder;
4. the `240s` TTL applies only to `acquired` rows for which the durable AI ledger proves no attempt was reserved; a reserved/nonterminal or ambiguous row crosses an inspection deadline into indefinite `quarantined` state and is never automatically reused;
5. a non-live request/job claim or a claim with less than `240,000ms` remaining cannot acquire, and a handler with less than `225,000ms` remaining cannot enter acquisition;
6. anon/authenticated have no table or RPC access;
7. lease TTL is `240s`, SDK HTTP/server timeout is `180,000ms`, terminal-persistence margin is `30,000ms`, and transport margin is `15,000ms`;
8. worker/service-role RPCs cannot clear quarantine; only a DB-owner-only function with the exact slot/fence and a closed safe-reason enum can resolve it after provider-side reconciliation, and it writes an immutable numeric/fenced audit record with no free-form text;
9. lease acquisition, launch readiness, and every transition that creates a new preflight, fresh admission, or authorized-test request fail closed while any quarantine exists;
10. idempotent reads/replays of an already-created preflight/request remain available, but cannot create sibling provider work.

The migration must put the quarantine assertion inside the authoritative database transitions, including new-row paths of `create_or_replay_analysis_v2_preflight`, `reserve_analysis_v2_preflight_admission`, and `consume_analysis_v2_authorized_test_entitlement`; an environment flag or route-only check is insufficient. PGlite/route tests set one slot to quarantine and prove public, fresh, and signed-test admissions make zero new rows/provider calls, return one sanitized unavailable code, while an existing request can still be read and cleaned up. The readiness evaluator reports only the quarantine count/blocker, never slot/fence identity.

- [ ] **Step 2: Implement the store and wait policy**

`v2-gemini-lease-store.ts` validates every RPC envelope. Acquisition polls with bounded jitter for at most `2,000ms` while the database verifies at least `240,000ms` remain on the live job claim; the worker also requires at least `225,000ms` on the monotonic Cloud Run handler deadline. Recheck both clocks immediately after acquisition and before attempt reservation; if either margin was consumed while polling, release the unreserved slot and requeue without an SDK call. It never reserves a Gemini paid attempt while no distributed slot is held.

If capacity wait expires, throw `ANALYSIS_V2_AI_CAPACITY_PENDING`; if the claim is too close to deadline, throw `ANALYSIS_V2_AI_DEADLINE_TOO_SHORT`; if any slot is quarantined, throw `ANALYSIS_V2_AI_QUARANTINE_ACTIVE`. Add all three exact codes to `v2-worker-error-codes.ts` so none collapses into the current permanent generic failure. Capacity/deadline use the ordinary bounded transient retry. Quarantine uses a fenced database deferral that releases the claim, schedules recovery at least five minutes later, returns HTTP success to stop Cloud Tasks hot retry, and does not count toward the ordinary terminal failure budget; it remains pending until the DB-owner incident resolution clears quarantine. Update `analyzeWithGemini` so its durable `onBeforeAttempt` wrapper preserves only those three allowlisted signals; all other hook failures remain the existing generic audit-persistence error. The SDK must not be called and no attempt telemetry may be fabricated for any of them.

Every `generateContent` request sets `config.httpOptions.timeout=180_000`. The client/request `retryOptions.attempts=1` disables hidden SDK retries so only the existing durable application policy can retry an explicit 429. Add an installed-SDK contract test with a stubbed fetch proving one fetch, timeout abort, millisecond units, and the `X-Server-Timeout` header.

- [ ] **Step 3: Integrate in paid-attempt order**

In `createAnalysisV2AiAuditAdapter.onBeforeAttempt`:

1. acquire a distributed lease;
2. reserve the durable AI attempt;
3. if reservation fails, release the just-acquired lease;
4. only then return control to `generateContent`.

In `onAttemptTelemetry`:

1. terminalize the result/attempt durably;
2. only after a known terminal provider response and durable persistence, release the exact fenced lease;
3. on timeout, network/5xx ambiguity, process crash after reservation, or persistence ambiguity, retain the slot and transition it to `quarantined` at reconciliation instead of freeing capacity for a possible still-running call;
4. an explicit terminal 429 releases after durable telemetry, and the application retry gets a new lease and attempt reservation;
5. a successful checkpoint/cache hit acquires no lease and makes no paid call.

Reservation failure before the SDK can run releases the just-acquired lease immediately. The lease reconciler may auto-recover only when the durable AI ledger proves no attempt was ever reserved; TTL alone is never proof that provider-side work stopped. A quarantined slot has no automatic lifetime. Clearing it is an incident action outside the worker, requires provider-side terminal evidence plus an explicit operator decision, and remains independently auditable.

- [ ] **Step 4: Test two-worker and two-revision behavior**

Instantiate two runtimes against the same PGlite database and prove aggregate active or quarantined possible generation never exceeds eight even when both processes can schedule work. Prove the ninth call fast-fails/requeues without SDK or attempt telemetry, an unreserved crash slot recovers, a reserved/ambiguous crash slot quarantines, and stale workers cannot release replacements. Test the exact `239,999ms`/`240,000ms` job-claim boundary and `224,999ms`/`225,000ms` handler boundary, and verify timeout/network/persistence ambiguity never returns capacity automatically. Repeated quarantine deferrals must make zero SDK calls, avoid hot task retries and terminal failure exhaustion, and resume only after audited resolution.

- [ ] **Step 5: Run full AI/worker regressions and commit**

```bash
npx vitest run \
  lib/services/analysis/v2-gemini-lease-store.test.ts \
  lib/services/analysis/v2-gemini-lease-migration-contract.test.ts \
  lib/services/analysis/v2-gemini-lease-pglite.test.ts \
  lib/services/analysis/v2-ai-result-store.test.ts \
  lib/services/ai/gemini.test.ts \
  lib/services/ai/stage-policy.test.ts \
  lib/services/analysis/v2-job-store.test.ts \
  lib/services/analysis/v2-worker.test.ts \
  lib/services/analysis/v2-worker-error-codes.test.ts \
  lib/services/analysis/v2-worker-route.test.ts \
  lib/services/analysis/v2-launch-readiness.test.ts \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/test-entitlement-route.test.ts
npm test
npm run lint
npm run build
git add supabase/migrations/20260718160000_add_analysis_v2_gemini_leases.sql \
  lib/services/analysis/v2-gemini-lease-* \
  lib/services/analysis/v2-ai-result-store.ts \
  lib/services/analysis/v2-ai-result-store.test.ts \
  lib/services/ai/gemini.ts lib/services/ai/gemini.test.ts \
  lib/services/ai/stage-policy.ts lib/services/ai/stage-policy.test.ts \
  lib/services/analysis/v2-job-store.ts \
  lib/services/analysis/v2-job-store.test.ts \
  lib/services/analysis/v2-worker.ts lib/services/analysis/v2-worker.test.ts \
  lib/services/analysis/v2-worker-error-codes.ts \
  lib/services/analysis/v2-worker-error-codes.test.ts \
  app/api/analysis/v2/worker/route.ts \
  lib/services/analysis/v2-worker-route.test.ts \
  lib/services/analysis/v2-launch-readiness.ts \
  lib/services/analysis/v2-launch-readiness.test.ts \
  lib/services/analysis/preflight.ts \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/test-entitlement-consumption.ts \
  lib/services/analysis/test-entitlement-route.test.ts \
  docs/authorized-apify-sharded-e2e-runbook.md docs/operations-cost-model.md
git commit -m "feat: fence deployment-wide Gemini concurrency"
```

- [ ] **Step 6: Push PR 5 through independent review, CI, and merge**

```bash
git push -u origin feat/distributed-gemini-lease
gh pr create --fill
```

The independent reviewer must inspect SQL locking, fence monotonicity, live-claim/minimum-time validation, timeout/retry configuration, acquire/reserve order, terminal/release order, indefinite quarantine and DB-owner-only resolution, central error allowlists, and old-revision rollout risk. Resolve every actionable finding, rerun focused and full verification, require green CI, merge to `main`, and record the exact merged SHA. Do not deploy a branch SHA or self-approve.

- [ ] **Step 7: Apply and deploy the exact merged SHA in a quiescent window**

Apply the reviewed migration first, then deploy the exact merged SHA only while no V2 request/job or Gemini lease is active. Shift Cloud Run to one lease-aware revision at 100%, verify Vercel/Cloud Run identity and the eight-slot contract, and run a zero-cost capacity test. After that first quiescent cutover, all future revisions share the distributed gate. Any quarantine or identity mismatch keeps automatic admission closed.

## Task 13: Follow-Up Outline for Controlled Early-Bird Rollout

- [ ] **Step 1: Keep fulfillment manual and one-at-a-time**

Use the existing 48-hour manual-delivery commitment. A verified Groble payment may authorize an operator-controlled analysis only through the documented order procedure; `payment_pending` never does. This plan does not authorize creating a payment or marking an order paid.

- [ ] **Step 2: Collect Basic and Standard samples separately**

For each controlled request record plan, counts, success/failure, stage walls, self-hosted/fallback/repair counts, correctly labeled provider actual, Gemini modeled/billed, and GCP metered/billed cost, mobile continuation, result QA, and cleanup. Do not combine Basic and Standard inventory or statistics.

- [ ] **Step 3: Compute p50/p95 only from an adequate declared sample**

The first successful Standard E2E is one sample, not p95. Use the available early-bird capacity as the controlled sample envelope, report sample size with every percentile, and include failures and abandoned preflight acquisition costs in commercial costing.

- [ ] **Step 4: Make a separate automatic-admission decision**

Enable Basic/Standard automatic analysis only when:

- distributed Gemini lease is deployed and verified;
- p95 total wall remains under five minutes with margin;
- p95 total economic cost supports the advertised price after fees/support/refunds;
- unknown usage, active ledger, and cleanup error rates meet the approved threshold;
- result/media/mobile/early-bird QA is green;
- a human explicitly approves the rollout.

Plus remains waitlist-only. Retain rollback flags and post-deploy canary monitoring.

## Final Report Template

At the end of the authorized E2E, report:

```text
E2E: SUCCESS | FAILED | BEHAVIOR_SUCCESS_COST_BLOCKED
Result URL:
Request ID:
Reviewed/deployed SHA:

Timing (ms)
- preflight/fresh admission:
- queue/fanout:
- relationships + target evidence:
- self-hosted profile attempts:
- initial Apify profile fallback:
- Apify repair:
- private names:
- gender triage:
- feature analysis:
- shortlist/reverse interactions:
- partner/narrative/finalize:
- total wall:

Coverage
- followers declared/collected:
- following declared/collected:
- mutual/public/private:
- detailed selected/not screened:
- self-hosted attempted/success/network-start/global-gate/circuit-open:
- self-hosted safe HTTP/failure buckets and latency count/sum/max/histogram:
- initial fallback requested/success/unavailable/incomplete:
- repair requested/success/unavailable/incomplete:
- missing profiles by batch:
- exact fallback/repair provenance:
- entitlement uniqueness and zero sibling requests:
- exclusion decision and per-stage excluded-identity occurrence counts:
- reel/carousel/slide-caption/media-bundle checks:
- target liker/comment and reverse-like checks:

Gemini
- per stage model/thinking/calls/retries/media/tokens/latency/cost:
- missing/malformed usage:

Cost (USD)
- preflight Apify:
- relationship Apify:
- profile fallback Apify:
- profile repair Apify:
- interaction Apify:
- Gemini token-complete modeled:
- Vertex/Gemini billed actual:
- Cloud Run metered x list price:
- Cloud Tasks metered x list price:
- Cloud Run/Tasks billed actual:
- E2E modeled unit total:
- E2E billed-actual total:
- micro-canary session R&D spend:
- total session spend (kept separate from unit cost):
- conservative upper bound, if any:
- cost status and evidence window:

Product/operations
- history/mobile continuation:
- private ordering/recent-mutual badge/result score UI:
- collection completeness and policy/UI consistency (no semantic-accuracy claim):
- QA payment_pending and Basic/Standard baseline/delta:
- discovered issues and fixing PRs:
- blockers before automatic analysis:
```

Do not substitute the two failed runs or the micro-canary for a completed Standard sample. Do not state an exact cost when any Gemini usage is missing.
