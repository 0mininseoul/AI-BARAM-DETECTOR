import { ApifyClient } from 'apify-client';
import type { InstagramFollower } from '@/lib/types/instagram';
import type { ProviderCallContext } from './types';
import { isInstagramUsername } from '../username';

export type ApifyClientLike = Pick<ApifyClient, 'actor' | 'dataset'>;
export type ApifyRelationshipKind = 'followers' | 'following';

export interface ApifyRelationshipActorDefinition {
    actorId: string;
    actorBuild?: string;
    actorConcurrency: number;
    minimumLimit: number;
    maximumLimit: number;
    maximumMetadataItems: number;
    maximumEstimatedCostUsd: number;
    datasetReadRetries: number;
    datasetRetryBaseDelayMs: number;
    estimatedCostPerResultUsd: number;
    minimumUniqueRatio: number;
    timeoutSecs: number;
    buildInput(username: string, kind: ApifyRelationshipKind, actorLimit: number): unknown;
    parseDataset(
        items: Array<Record<string, unknown>>,
        username: string,
        kind: ApifyRelationshipKind,
        actorLimit: number
    ): InstagramFollower[];
}

interface ActorWaiter {
    limit: number;
    resolve(): void;
}

class SharedActorSemaphore {
    private active = 0;
    private readonly queue: ActorWaiter[] = [];

    async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
        await this.acquire(limit);
        try {
            return await task();
        } finally {
            this.active--;
            this.drain();
        }
    }

    private acquire(limit: number): Promise<void> {
        if (this.queue.length === 0 && this.active < limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push({ limit, resolve });
        });
    }

    private drain(): void {
        while (this.queue.length > 0 && this.active < this.queue[0].limit) {
            const waiter = this.queue.shift();
            if (!waiter) return;
            this.active++;
            waiter.resolve();
        }
    }
}

const sharedActorSemaphore = new SharedActorSemaphore();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function runWithApifyActorSlot<T>(
    concurrency: number,
    task: () => Promise<T>
): Promise<T> {
    return sharedActorSemaphore.run(concurrency, task);
}

function assertLimit(limit: number, maximum: number): void {
    if (!Number.isInteger(limit) || limit < 0 || limit > maximum) {
        throw new Error(`SCRAPING_CONFIG_ERROR: limit은 0~${maximum} 범위의 정수여야 합니다.`);
    }
}

export function getApifyClient(
    env: Record<string, string | undefined> = process.env
): ApifyClient {
    const token = env.APIFY_API_TOKEN;
    if (!token) throw new Error('SCRAPING_CONFIG_ERROR: APIFY_API_TOKEN이 설정되지 않았습니다.');
    return new ApifyClient({ token });
}

function actorRequestError(error: unknown): Error {
    if (error && typeof error === 'object') {
        const statusCode = (error as { statusCode?: unknown }).statusCode;
        if (
            typeof statusCode === 'number' &&
            Number.isInteger(statusCode) &&
            statusCode >= 400 &&
            statusCode <= 599
        ) {
            return new Error(
                `SCRAPING_ERROR: Apify actor transport request failed (HTTP ${statusCode}).`
            );
        }
    }
    return new Error('SCRAPING_ERROR: Apify actor transport request failed.');
}

export function numberSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 ${min}~${max} 범위의 숫자여야 합니다.`);
    }
    return value;
}

export function integerSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const value = numberSetting(env, key, fallback, min, max);
    if (!Number.isInteger(value)) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 정수여야 합니다.`);
    }
    return value;
}

export async function runApifyRelationshipActor(
    client: ApifyClientLike,
    definition: ApifyRelationshipActorDefinition,
    username: string,
    kind: ApifyRelationshipKind,
    limit: number,
    context?: ProviderCallContext
): Promise<InstagramFollower[]> {
    assertLimit(limit, definition.maximumLimit);
    if (limit === 0) return [];

    const account = username.trim().replace(/^@/, '').toLowerCase();
    if (!isInstagramUsername(account)) {
        throw new Error('SCRAPING_CONFIG_ERROR: Instagram username 형식이 올바르지 않습니다.');
    }

    const actorLimit = Math.max(definition.minimumLimit, limit);
    const datasetLimit = actorLimit + definition.maximumMetadataItems;
    const maximumEstimatedCostUsd = datasetLimit * definition.estimatedCostPerResultUsd;
    if (
        maximumEstimatedCostUsd >
        definition.maximumEstimatedCostUsd + Number.EPSILON
    ) {
        throw new Error(
            'SCRAPING_BUDGET_ERROR: Apify actor estimated-cost ceiling would be exceeded.'
        );
    }
    return runWithApifyActorSlot(definition.actorConcurrency, async () => {
        context?.recordUsage({ request_count: 1 });
        let run;
        try {
            run = await client.actor(definition.actorId).call(
                definition.buildInput(account, kind, actorLimit),
                {
                    timeout: definition.timeoutSecs,
                    waitSecs: definition.timeoutSecs,
                    maxItems: datasetLimit,
                    log: null,
                    ...(definition.actorBuild ? { build: definition.actorBuild } : {}),
                }
            );
        } catch (error) {
            throw actorRequestError(error);
        }

        if (run.status !== 'SUCCEEDED') {
            throw new Error(`SCRAPING_ERROR: Apify actor 실행 실패 (status=${run.status}).`);
        }
        if (!run.defaultDatasetId) {
            throw new Error('SCRAPING_SCHEMA_ERROR: Apify run에 defaultDatasetId가 없습니다.');
        }

        const items: Array<Record<string, unknown>> = [];
        const dataset = client.dataset(run.defaultDatasetId);
        const chargedItemsByOffset = new Map<number, number>();
        let offset = 0;
        let expectedTotal: number | undefined;
        while (offset <= datasetLimit) {
            const pageLimit = Math.min(1_000, datasetLimit + 1 - offset);
            let page;
            let invariantError: Error | undefined;
            for (let attempt = 0; attempt <= definition.datasetReadRetries; attempt++) {
                try {
                    page = await dataset.listItems({ offset, limit: pageLimit });
                } catch {
                    page = undefined;
                    invariantError = new Error(
                        'SCRAPING_ERROR: APIFY_DATASET_TRANSPORT_EXHAUSTED Apify dataset transport request failed.'
                    );
                }
                if (page && !Array.isArray(page.items)) {
                    throw new Error('SCRAPING_SCHEMA_ERROR: Apify dataset items가 배열이 아닙니다.');
                }
                if (!page) {
                    if (attempt < definition.datasetReadRetries) {
                        await sleep(definition.datasetRetryBaseDelayMs * 2 ** attempt);
                    }
                    continue;
                }
                const alreadyCharged = chargedItemsByOffset.get(offset) ?? 0;
                if (page.items.length > alreadyCharged) {
                    context?.recordUsage({
                        estimated_cost_usd:
                            (page.items.length - alreadyCharged) *
                            definition.estimatedCostPerResultUsd,
                    });
                    chargedItemsByOffset.set(offset, page.items.length);
                }

                invariantError = undefined;
                if (!Number.isInteger(page.total) || page.total < 0) {
                    invariantError = new Error(
                        'SCRAPING_SCHEMA_ERROR: APIFY_DATASET_TOTAL_INVALID Apify dataset total이 유효한 정수가 아닙니다.'
                    );
                } else if (!Number.isInteger(page.offset) || page.offset !== offset) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_OFFSET_MISMATCH Apify dataset offset이 요청과 다릅니다.'
                    );
                } else if (!Number.isInteger(page.count) || page.count !== page.items.length) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_COUNT_MISMATCH Apify dataset count가 items 길이와 다릅니다.'
                    );
                } else if (expectedTotal !== undefined && expectedTotal !== page.total) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_TOTAL_CHANGED Apify dataset total이 페이지 사이에 변경되었습니다.'
                    );
                } else if (offset + page.items.length > page.total) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_TOTAL_LAGGING Apify dataset 페이지가 total을 초과했습니다.'
                    );
                } else if (page.items.length === 0 && offset < page.total) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_PAGE_EMPTY Apify dataset 페이지가 중간에서 비었습니다.'
                    );
                } else if (
                    offset === 0 &&
                    page.total === 0 &&
                    page.items.length === 0 &&
                    attempt < definition.datasetReadRetries
                ) {
                    invariantError = new Error(
                        'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_EMPTY_UNSETTLED Apify dataset이 아직 비어 있습니다.'
                    );
                }
                if (!invariantError) break;
                if (attempt < definition.datasetReadRetries) {
                    await sleep(definition.datasetRetryBaseDelayMs * 2 ** attempt);
                }
            }
            if (invariantError) throw invariantError;
            if (!page) {
                throw new Error('SCRAPING_ERROR: Apify dataset response missing.');
            }

            expectedTotal = page.total;
            items.push(...page.items);
            offset += page.items.length;
            if (offset >= page.total) break;
        }
        if ((expectedTotal ?? 0) > datasetLimit || items.length > datasetLimit) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_LIMIT_EXCEEDED Apify dataset이 요청한 결과 한도를 초과했습니다.'
            );
        }
        if (expectedTotal !== undefined && items.length !== expectedTotal) {
            throw new Error(
                'SCRAPING_INCOMPLETE_ERROR: APIFY_DATASET_READ_INCOMPLETE Apify dataset을 끝까지 읽지 못했습니다.'
            );
        }
        const mapped = definition.parseDataset(items, account, kind, actorLimit);
        if (mapped.length > actorLimit) {
            throw new Error(
                'SCRAPING_SCHEMA_ERROR: APIFY_RESULT_LIMIT_EXCEEDED Apify actor가 resultsLimit보다 많은 결과를 반환했습니다.'
            );
        }

        const unique = new Map<string, InstagramFollower>();
        for (const user of mapped) {
            const key = user.username.toLowerCase();
            if (!unique.has(key)) unique.set(key, user);
        }
        const uniqueRatio = mapped.length > 0 ? unique.size / mapped.length : 1;
        if (uniqueRatio < definition.minimumUniqueRatio) {
            context?.recordUsage({
                raw_result_count: mapped.length,
                unique_result_count: unique.size,
            });
            throw new Error('SCRAPING_INCOMPLETE_ERROR: Apify 결과의 중복 비율이 허용 범위를 초과했습니다.');
        }
        const result = [...unique.values()].slice(0, limit);
        context?.recordUsage({
            result_count: result.length,
            raw_result_count: mapped.length,
            unique_result_count: unique.size,
        });
        return result;
    });
}
