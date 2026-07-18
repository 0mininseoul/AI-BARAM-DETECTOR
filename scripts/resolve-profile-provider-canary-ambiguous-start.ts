import { createHash, timingSafeEqual } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    PROFILE_PROVIDER_CANARY_ACTOR,
    profileProviderCanaryRunStore,
    type ProfileProviderCanaryRunStore,
} from '../lib/services/analysis/profile-provider-canary-run-store';
import { getApifyClient } from '../lib/services/instagram/providers/apify-relationship';
import { orderedProfileProviderCanaryHmac } from './profile-provider-canary-runtime';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HMAC_PATTERN = /^[0-9a-f]{64}$/i;
const CLOCK_SKEW_MS = 60_000;
const NO_RUN_OBSERVATION_MIN_AGE_MS = 120_000;
const NO_RUN_RECHECK_DELAY_MS = 10_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const CANDIDATE_PAGE_LIMIT = 100;
const MAX_EVIDENCE_REFERENCE_BYTES = 4_096;
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface ProfileProviderCanaryAmbiguousStartOptions {
    sourceRequestId: string;
    repetition: 1 | 2;
    evidenceReferenceFile: string;
    sqlOutputFile: string;
    confirmAmbiguousStartResolution: true;
}

export type ProfileProviderCanaryAmbiguousStartOutcome =
    | 'owner_sql_artifact_written'
    | 'blocked_input_mismatch'
    | 'blocked_multiple_candidates'
    | 'blocked_candidate_set_unstable';
export type ProfileProviderCanaryResolutionArtifactKind =
    | 'verified_no_run'
    | 'adopt_run';

export interface ProfileProviderCanaryAmbiguousStartResult {
    mode: 'resolve_ambiguous_start';
    repetition: 1 | 2;
    outcome: ProfileProviderCanaryAmbiguousStartOutcome;
    actor_start_count: 0;
    artifact_written: boolean;
    artifact_kind: ProfileProviderCanaryResolutionArtifactKind | null;
}

export interface ProfileProviderCanaryAmbiguousStartDependencies {
    now?(): number;
    wait?(delayMs: number): Promise<void>;
    loadAmbiguousReservation(input: {
        sourceRequestId: string;
        repetition: 1 | 2;
    }): Promise<{
        state: 'ambiguous';
        orderedSetHmac: string;
        reservationToken: string;
        actorId: 'apify/instagram-scraper';
        actorBuild: '0.0.692';
        credentialSlot: 'primary';
        reservedAt: string;
        ambiguousAt: string;
    }>;
    listStartCandidates(input: {
        actorId: 'apify/instagram-scraper';
        actorBuild: '0.0.692';
        credentialSlot: 'primary';
        startedAfter: string;
        startedBefore: string;
    }): Promise<Array<{
        runId: string;
        inputHmac: string;
        actorId: 'apify/instagram-scraper';
        actorBuild: string;
        credentialSlot: 'primary';
        startedAt: string;
    }>>;
    writeOwnerSqlArtifact(input: {
        kind: 'verified_no_run' | 'adopt_run';
        sourceRequestId: string;
        repetition: 1 | 2;
        reservationToken: string;
        orderedSetHmac: string;
        evidenceReferenceFile: string;
        sqlOutputFile: string;
        candidate?: {
            runId: string;
            actorId: 'apify/instagram-scraper';
            actorBuild: '0.0.692';
            credentialSlot: 'primary';
            startedAt: string;
        };
    }): Promise<void>;
    writeStdout?(value: string): void;
}

interface ResolverRunListItem {
    id?: unknown;
    buildNumber?: unknown;
    startedAt?: unknown;
}

interface ResolverApifyClient {
    actor(actorId: string): {
        runs(): {
            list(options: {
                desc: false;
                limit: number;
                startedAfter: string;
                startedBefore: string;
            }): PromiseLike<{ total?: unknown; items?: unknown }>;
        };
    };
    run(runId: string): {
        keyValueStore(): { getRecord(key: 'INPUT'): Promise<unknown> };
    };
}

export interface ProfileProviderCanaryAmbiguousStartRuntimeOverrides {
    env?: Record<string, string | undefined>;
    store?: Pick<ProfileProviderCanaryRunStore, 'loadExperiment' | 'loadRun'>;
    getClient?: () => ResolverApifyClient;
    writeOwnerSqlArtifact?: ProfileProviderCanaryAmbiguousStartDependencies['writeOwnerSqlArtifact'];
    writeStdout?: (value: string) => void;
    now?: () => number;
    wait?: (delayMs: number) => Promise<void>;
}

function safeError(code: string): Error {
    return new Error(code);
}

function parsedTimestamp(value: string): number {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw safeError('AMBIGUOUS_RESERVATION_INVALID');
    return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inputUsernames(value: unknown): string[] | null {
    const input = isRecord(value) && 'value' in value ? value.value : value;
    if (!isRecord(input)
        || Object.keys(input).sort().join(',') !== 'directUrls,resultsType'
        || input.resultsType !== 'details'
        || !Array.isArray(input.directUrls)
        || input.directUrls.length !== 15) return null;
    const usernames = input.directUrls.map(url => typeof url === 'string'
        ? /^https:\/\/www\.instagram\.com\/([A-Za-z0-9._]{1,30})\/$/.exec(url)?.[1]
        : undefined);
    return usernames.some(username => !username) ? null : usernames as string[];
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function isWithinRepository(path: string, repositoryRoot: string): boolean {
    const fromRoot = relative(repositoryRoot, path);
    return fromRoot === ''
        || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

async function evidenceHash(path: string): Promise<string> {
    const contents = await readFile(path);
    if (contents.byteLength < 1 || contents.byteLength > MAX_EVIDENCE_REFERENCE_BYTES) {
        throw safeError('PROFILE_PROVIDER_CANARY_EVIDENCE_INVALID');
    }
    const reference = contents.toString('utf8').trim();
    if (!reference) throw safeError('PROFILE_PROVIDER_CANARY_EVIDENCE_INVALID');
    return createHash('sha256').update(reference, 'utf8').digest('hex');
}

export async function writeProfileProviderCanaryOwnerSqlArtifact(input: Parameters<
    ProfileProviderCanaryAmbiguousStartDependencies['writeOwnerSqlArtifact']
>[0]): Promise<void> {
    if (!isAbsolute(input.evidenceReferenceFile) || !isAbsolute(input.sqlOutputFile)
        || !UUID_PATTERN.test(input.sourceRequestId)
        || !UUID_PATTERN.test(input.reservationToken)
        || !HMAC_PATTERN.test(input.orderedSetHmac)) {
        throw safeError('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_INVALID');
    }
    if (input.kind === 'adopt_run' && (!input.candidate
        || !RUN_ID_PATTERN.test(input.candidate.runId)
        || input.candidate.actorId !== PROFILE_PROVIDER_CANARY_ACTOR.actorId
        || input.candidate.actorBuild !== PROFILE_PROVIDER_CANARY_ACTOR.build
        || input.candidate.credentialSlot !== 'primary'
        || !Number.isFinite(Date.parse(input.candidate.startedAt)))) {
        throw safeError('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_INVALID');
    }
    const repositoryRoot = await realpath(REPOSITORY_ROOT);
    const outputParent = await realpath(dirname(input.sqlOutputFile));
    const outputPath = resolve(outputParent, basename(input.sqlOutputFile));
    if (isWithinRepository(outputPath, repositoryRoot)) {
        throw safeError('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_PATH_INVALID');
    }
    const referenceHash = await evidenceHash(input.evidenceReferenceFile);
    const common = [
        `${sqlLiteral(input.sourceRequestId)}::UUID`,
        `${input.repetition}::INTEGER`,
        `${sqlLiteral(input.reservationToken)}::UUID`,
    ];
    const values = input.kind === 'verified_no_run'
        ? [...common, `${sqlLiteral(referenceHash)}::TEXT`]
        : [
            ...common,
            `${sqlLiteral(input.candidate?.runId ?? '')}::TEXT`,
            `${sqlLiteral(input.candidate?.actorId ?? '')}::TEXT`,
            `${sqlLiteral(input.candidate?.actorBuild ?? '')}::TEXT`,
            `${sqlLiteral(input.candidate?.credentialSlot ?? '')}::TEXT`,
            `${sqlLiteral(input.candidate?.startedAt ?? '')}::TIMESTAMP WITH TIME ZONE`,
            `${sqlLiteral(input.orderedSetHmac)}::TEXT`,
            `${sqlLiteral(referenceHash)}::TEXT`,
        ];
    const functionName = input.kind === 'verified_no_run'
        ? 'resolve_analysis_v2_profile_provider_canary_no_run'
        : 'resolve_analysis_v2_profile_provider_canary_adopt_run';
    const contents = [
        '-- Database-owner-only, review-before-execution artifact.',
        '-- Execute only as the Supabase project database owner; service_role must be denied.',
        `SELECT public.${functionName}(`,
        values.map((value, index) => `    ${value}${index < values.length - 1 ? ',' : ''}`)
            .join('\n'),
        ');',
        '',
    ].join('\n');
    let handle;
    try {
        handle = await open(outputPath, 'wx', 0o600);
        await handle.writeFile(contents, { encoding: 'utf8' });
        await handle.chmod(0o600);
        await handle.sync();
    } catch (error) {
        if (isRecord(error) && error.code === 'EEXIST') {
            const existing = await readFile(outputPath, 'utf8');
            if (existing === contents && ((await stat(outputPath)).mode & 0o777) === 0o600) return;
        }
        throw safeError('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_WRITE_FAILED');
    } finally {
        await handle?.close();
    }
    if (((await stat(outputPath)).mode & 0o777) !== 0o600) {
        throw safeError('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_MODE_INVALID');
    }
}

export function createProfileProviderCanaryAmbiguousStartDependencies(
    overrides: ProfileProviderCanaryAmbiguousStartRuntimeOverrides = {}
): ProfileProviderCanaryAmbiguousStartDependencies {
    const env = overrides.env ?? process.env;
    const store = overrides.store ?? profileProviderCanaryRunStore;
    const getClient = overrides.getClient
        ?? (() => getApifyClient(env, 'primary') as unknown as ResolverApifyClient);
    return {
        now: overrides.now ?? Date.now,
        wait: overrides.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs))),
        async loadAmbiguousReservation(input) {
            const [experiment, run] = await Promise.all([
                store.loadExperiment({ sourceRequestId: input.sourceRequestId }),
                store.loadRun(input),
            ]);
            if (!experiment || !run || run.state !== 'ambiguous'
                || !experiment.orderedSetHmac || !run.ambiguousAt
                || run.actorId !== PROFILE_PROVIDER_CANARY_ACTOR.actorId
                || run.actorBuild !== PROFILE_PROVIDER_CANARY_ACTOR.build
                || run.credentialSlot !== 'primary') {
                throw safeError('AMBIGUOUS_RESERVATION_INVALID');
            }
            return {
                state: 'ambiguous' as const,
                orderedSetHmac: experiment.orderedSetHmac,
                reservationToken: run.reservationToken,
                actorId: PROFILE_PROVIDER_CANARY_ACTOR.actorId,
                actorBuild: PROFILE_PROVIDER_CANARY_ACTOR.build,
                credentialSlot: 'primary' as const,
                reservedAt: run.reservedAt,
                ambiguousAt: run.ambiguousAt,
            };
        },
        async listStartCandidates(input) {
            try {
                const client = getClient();
                const page = await client.actor(input.actorId).runs().list({
                    desc: false,
                    limit: CANDIDATE_PAGE_LIMIT,
                    startedAfter: input.startedAfter,
                    startedBefore: input.startedBefore,
                });
                if (!isRecord(page) || !Number.isInteger(page.total)
                    || !Array.isArray(page.items) || (page.total as number) < 0
                    || (page.total as number) > CANDIDATE_PAGE_LIMIT
                    || page.items.length > CANDIDATE_PAGE_LIMIT
                    || page.items.length > (page.total as number)
                    || page.items.length !== page.total) {
                    throw safeError('PROFILE_PROVIDER_CANARY_CANDIDATE_SET_INVALID');
                }
                const items = page.items as ResolverRunListItem[];
                return Promise.all(items.map(async item => {
                    const runId = typeof item.id === 'string' ? item.id : '';
                    const actorBuild = typeof item.buildNumber === 'string'
                        ? item.buildNumber : '';
                    const startedAt = item.startedAt instanceof Date
                        ? item.startedAt.toISOString() : String(item.startedAt ?? '');
                    if (!RUN_ID_PATTERN.test(runId) || !actorBuild
                        || !Number.isFinite(Date.parse(startedAt))) {
                        throw safeError('PROFILE_PROVIDER_CANARY_CANDIDATE_SET_INVALID');
                    }
                    if (actorBuild !== input.actorBuild) {
                        return {
                            runId,
                            actorId: PROFILE_PROVIDER_CANARY_ACTOR.actorId,
                            actorBuild,
                            credentialSlot: 'primary' as const,
                            startedAt,
                            inputHmac: '',
                        };
                    }
                    const inputRecord = await client.run(runId).keyValueStore().getRecord('INPUT');
                    const usernames = inputUsernames(inputRecord);
                    return {
                        runId,
                        actorId: PROFILE_PROVIDER_CANARY_ACTOR.actorId,
                        actorBuild,
                        credentialSlot: 'primary' as const,
                        startedAt,
                        inputHmac: usernames
                            ? orderedProfileProviderCanaryHmac(usernames, env) : '',
                    };
                }));
            } catch {
                throw safeError('PROFILE_PROVIDER_CANARY_CANDIDATE_READ_FAILED');
            }
        },
        writeOwnerSqlArtifact: overrides.writeOwnerSqlArtifact
            ?? writeProfileProviderCanaryOwnerSqlArtifact,
        writeStdout: overrides.writeStdout ?? (value => process.stdout.write(value)),
    };
}

export function parseProfileProviderCanaryAmbiguousStartArgs(
    args: readonly string[]
): ProfileProviderCanaryAmbiguousStartOptions {
    let sourceRequestId: string | null = null;
    let repetition: 1 | 2 | null = null;
    let evidenceReferenceFile: string | null = null;
    let sqlOutputFile: string | null = null;
    let confirmationCount = 0;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--source-request-id') {
            if (sourceRequestId !== null) {
                throw safeError('--source-request-id must appear exactly once');
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw safeError('--source-request-id is required');
            }
            sourceRequestId = value;
            index += 1;
            continue;
        }
        if (argument === '--repetition') {
            if (repetition !== null) {
                throw safeError('--repetition must appear exactly once');
            }
            const value = args[index + 1];
            if (value !== '1' && value !== '2') {
                throw safeError('--repetition must be 1 or 2');
            }
            repetition = Number(value) as 1 | 2;
            index += 1;
            continue;
        }
        if (argument === '--evidence-reference-file' || argument === '--sql-output-file') {
            const current = argument === '--evidence-reference-file'
                ? evidenceReferenceFile
                : sqlOutputFile;
            if (current !== null) {
                throw safeError(`${argument} must appear exactly once`);
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw safeError(`${argument} is required`);
            }
            if (argument === '--evidence-reference-file') evidenceReferenceFile = value;
            else sqlOutputFile = value;
            index += 1;
            continue;
        }
        if (argument === '--confirm-ambiguous-start-resolution') {
            confirmationCount += 1;
            if (confirmationCount > 1) {
                throw safeError('--confirm-ambiguous-start-resolution must appear exactly once');
            }
            continue;
        }
        if (argument.startsWith('--confirm-ambiguous-start-resolution=')) {
            throw safeError('--confirm-ambiguous-start-resolution must be exact and valueless');
        }
        throw safeError(`unknown argument: ${argument}`);
    }

    if (!sourceRequestId || repetition === null || !evidenceReferenceFile || !sqlOutputFile
        || confirmationCount !== 1) {
        throw safeError('all ambiguous-start resolution arguments are required');
    }
    if (!UUID_PATTERN.test(sourceRequestId)) {
        throw safeError('invalid arguments');
    }

    return {
        sourceRequestId,
        repetition,
        evidenceReferenceFile,
        sqlOutputFile,
        confirmAmbiguousStartResolution: true,
    };
}

function hmacMatches(left: string, right: string): boolean {
    if (!HMAC_PATTERN.test(left) || !HMAC_PATTERN.test(right)) return false;
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function result(
    repetition: 1 | 2,
    outcome: ProfileProviderCanaryAmbiguousStartOutcome,
    artifactKind: ProfileProviderCanaryResolutionArtifactKind | null = null
): ProfileProviderCanaryAmbiguousStartResult {
    return {
        mode: 'resolve_ambiguous_start',
        repetition,
        outcome,
        actor_start_count: 0,
        artifact_written: artifactKind !== null,
        artifact_kind: artifactKind,
    };
}

async function writeOwnerSqlArtifactSafely(
    dependencies: ProfileProviderCanaryAmbiguousStartDependencies,
    input: Parameters<ProfileProviderCanaryAmbiguousStartDependencies['writeOwnerSqlArtifact']>[0]
): Promise<void> {
    try {
        await dependencies.writeOwnerSqlArtifact(input);
    } catch {
        throw safeError('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_WRITE_FAILED');
    }
}

export async function resolveProfileProviderCanaryAmbiguousStart(
    options: ProfileProviderCanaryAmbiguousStartOptions,
    dependencies: ProfileProviderCanaryAmbiguousStartDependencies
): Promise<ProfileProviderCanaryAmbiguousStartResult> {
    const identity = {
        sourceRequestId: options.sourceRequestId,
        repetition: options.repetition,
    };
    const reservation = await dependencies.loadAmbiguousReservation(identity);
    if (reservation.state !== 'ambiguous' || !HMAC_PATTERN.test(reservation.orderedSetHmac)) {
        throw safeError('AMBIGUOUS_RESERVATION_INVALID');
    }

    const reservedAt = parsedTimestamp(reservation.reservedAt);
    const ambiguousAt = parsedTimestamp(reservation.ambiguousAt);
    if (ambiguousAt < reservedAt) {
        throw safeError('AMBIGUOUS_RESERVATION_INVALID');
    }
    const observationNow = dependencies.now?.() ?? Date.now();
    if (!Number.isFinite(observationNow)
        || observationNow - ambiguousAt < NO_RUN_OBSERVATION_MIN_AGE_MS) {
        throw safeError('PROFILE_PROVIDER_CANARY_NO_RUN_OBSERVATION_TOO_EARLY');
    }
    const startedAfter = new Date(reservedAt - CLOCK_SKEW_MS).toISOString();
    const startedBefore = new Date(ambiguousAt + CLOCK_SKEW_MS).toISOString();
    const candidates = await dependencies.listStartCandidates({
        actorId: reservation.actorId,
        actorBuild: reservation.actorBuild,
        credentialSlot: reservation.credentialSlot,
        startedAfter,
        startedBefore,
    });
    if (candidates.length === 0) {
        await (dependencies.wait?.(NO_RUN_RECHECK_DELAY_MS)
            ?? new Promise(resolve => setTimeout(resolve, NO_RUN_RECHECK_DELAY_MS)));
        const repeatedCandidates = await dependencies.listStartCandidates({
            actorId: reservation.actorId,
            actorBuild: reservation.actorBuild,
            credentialSlot: reservation.credentialSlot,
            startedAfter,
            startedBefore,
        });
        if (repeatedCandidates.length !== 0) {
            return result(options.repetition, 'blocked_candidate_set_unstable');
        }
        await writeOwnerSqlArtifactSafely(dependencies, {
            kind: 'verified_no_run',
            ...identity,
            reservationToken: reservation.reservationToken,
            orderedSetHmac: reservation.orderedSetHmac,
            evidenceReferenceFile: options.evidenceReferenceFile,
            sqlOutputFile: options.sqlOutputFile,
        });
        return result(options.repetition, 'owner_sql_artifact_written', 'verified_no_run');
    }
    const invalidCandidate = candidates.some(candidate => {
        const candidateStartedAt = Date.parse(candidate.startedAt);
        return candidate.actorId !== reservation.actorId
            || candidate.credentialSlot !== reservation.credentialSlot
            || !Number.isFinite(candidateStartedAt)
            || candidateStartedAt < Date.parse(startedAfter)
            || candidateStartedAt > Date.parse(startedBefore)
            || typeof candidate.runId !== 'string'
            || !RUN_ID_PATTERN.test(candidate.runId);
    });
    if (invalidCandidate) {
        return result(options.repetition, 'blocked_input_mismatch');
    }
    const exactCandidates = candidates.filter(candidate =>
        candidate.actorBuild === reservation.actorBuild
        && hmacMatches(reservation.orderedSetHmac, candidate.inputHmac)
    );
    if (exactCandidates.length > 1) {
        return result(options.repetition, 'blocked_multiple_candidates');
    }
    if (exactCandidates.length === 0) {
        return result(options.repetition, 'blocked_input_mismatch');
    }

    const [candidate] = exactCandidates;
    const candidateStartedAt = Date.parse(candidate.startedAt);
    if (candidate.actorId !== reservation.actorId
        || candidate.actorBuild !== reservation.actorBuild
        || candidate.credentialSlot !== reservation.credentialSlot
        || !Number.isFinite(candidateStartedAt)
        || candidateStartedAt < Date.parse(startedAfter)
        || candidateStartedAt > Date.parse(startedBefore)) {
        return result(options.repetition, 'blocked_input_mismatch');
    }
    if (typeof candidate.runId !== 'string'
        || candidate.runId.length === 0
        || !hmacMatches(reservation.orderedSetHmac, candidate.inputHmac)) {
        return result(options.repetition, 'blocked_input_mismatch');
    }

    await writeOwnerSqlArtifactSafely(dependencies, {
        kind: 'adopt_run',
        ...identity,
        reservationToken: reservation.reservationToken,
        orderedSetHmac: reservation.orderedSetHmac,
        evidenceReferenceFile: options.evidenceReferenceFile,
        sqlOutputFile: options.sqlOutputFile,
        candidate: {
            runId: candidate.runId,
            actorId: reservation.actorId,
            actorBuild: reservation.actorBuild,
            credentialSlot: reservation.credentialSlot,
            startedAt: candidate.startedAt,
        },
    });
    return result(options.repetition, 'owner_sql_artifact_written', 'adopt_run');
}

function defaultDependencies(): ProfileProviderCanaryAmbiguousStartDependencies {
    return createProfileProviderCanaryAmbiguousStartDependencies();
}

export async function runProfileProviderCanaryAmbiguousStartCli(
    args: readonly string[],
    dependencies: ProfileProviderCanaryAmbiguousStartDependencies = defaultDependencies()
): Promise<ProfileProviderCanaryAmbiguousStartResult> {
    const resolved = await resolveProfileProviderCanaryAmbiguousStart(
        parseProfileProviderCanaryAmbiguousStartArgs(args),
        dependencies
    );
    (dependencies.writeStdout ?? (value => process.stdout.write(value)))(
        `${JSON.stringify(resolved)}\n`
    );
    return resolved;
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runProfileProviderCanaryAmbiguousStartCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            error_code: 'profile_provider_canary_ambiguous_start_resolution_failed',
        })}\n`);
        process.exitCode = 1;
    });
}
