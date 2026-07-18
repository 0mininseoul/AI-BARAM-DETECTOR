import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
    classifyPreflightWorkerFailure,
    processPreflight,
} from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getPreflightTasksConfig,
    verifyPreflightTaskAuthorization,
} from '@/lib/services/analysis/preflight-tasks';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';

const workerRequestSchema = z.union([
    z.object({
        preflightId: z.string().uuid(),
    }).strict(),
    z.object({
        preflightId: z.string().uuid(),
        kind: z.literal('fresh_admission'),
        generation: z.number().int().min(1).max(100),
        dispatchGeneration: z.number().int().min(1).max(100),
        dispatchToken: z.string().uuid(),
    }).strict(),
]);

function workerErrorCode(category: string): string {
    if (category === 'rate_limit') return 'RATE_LIMITED';
    if (category === 'timeout') return 'TIMEOUT';
    if (category === 'configuration') return 'JOB_DISPATCH_NOT_READY';
    if (category === 'persistence') return 'INTERNAL_ERROR';
    if (category === 'unknown') return 'UNKNOWN';
    return 'PROVIDER_ERROR';
}

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const reject = (status: number, errorCode: string): NextResponse => {
        operationalLogger.emit({
            event: 'preflight.failed',
            severity: status >= 500 ? 'error' : 'warn',
            fields: {
                ...context,
                operation: 'preflight',
                disposition: status >= 500 ? 'failed' : 'rejected',
                error_code: errorCode,
            },
        });
        return NextResponse.json({
            code: status === 401
                ? 'UNAUTHORIZED'
                : status === 400 ? 'INVALID_REQUEST' : 'QUEUE_UNAVAILABLE',
        }, { status });
    };

    let config;
    try {
        config = getPreflightTasksConfig();
    } catch {
        return reject(503, 'JOB_DISPATCH_NOT_READY');
    }
    if (!config || !await verifyPreflightTaskAuthorization(
        request.headers.get('authorization'),
        { config }
    )) {
        return reject(401, 'UNAUTHORIZED');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return reject(400, 'INVALID_REQUEST');
    }
    const parsed = workerRequestSchema.safeParse(body);
    if (!parsed.success) {
        return reject(400, 'INVALID_REQUEST');
    }

    try {
        const outcome = 'kind' in parsed.data
            ? await processAnalysisV2FreshAdmission(supabaseAdmin, {
                preflightId: parsed.data.preflightId,
                generation: parsed.data.generation,
                dispatchGeneration: parsed.data.dispatchGeneration,
                dispatchToken: parsed.data.dispatchToken,
            })
            : await processPreflight(parsed.data.preflightId);
        const operation = 'kind' in parsed.data ? 'fresh_admission' : 'profile';
        const disposition = outcome === 'noop' ? 'exists' : outcome;
        if (!('kind' in parsed.data) && outcome === 'ready') {
            operationalLogger.emit({
                event: 'preflight.profile_collected',
                severity: 'info',
                fields: {
                    ...context,
                    preflight_id: parsed.data.preflightId,
                    operation,
                    disposition,
                },
            });
        }
        operationalLogger.emit({
            event: 'preflight.completed',
            severity: outcome === 'blocked' ? 'warn' : 'info',
            fields: {
                ...context,
                preflight_id: parsed.data.preflightId,
                operation,
                disposition,
            },
        });
        return NextResponse.json({ status: outcome });
    } catch (error) {
        const failure = classifyPreflightWorkerFailure(error);
        console.error(JSON.stringify({
            event: 'preflight_worker_failed',
            operation: 'kind' in parsed.data ? 'fresh_admission' : 'profile',
            category: failure.category,
            retryable: failure.retryable,
            httpStatus: failure.httpStatus,
            workerAttemptCount: failure.workerAttemptCount,
        }));
        operationalLogger.emit({
            event: 'preflight.failed',
            severity: 'error',
            fields: {
                ...context,
                preflight_id: parsed.data.preflightId,
                operation: 'kind' in parsed.data ? 'fresh_admission' : 'profile',
                disposition: 'failed',
                retryable: failure.retryable,
                ...(failure.httpStatus === null ? {} : { status: failure.httpStatus }),
                ...(failure.workerAttemptCount === null
                    ? {}
                    : { attempt: failure.workerAttemptCount }),
                error_code: workerErrorCode(failure.category),
            },
        });
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/analysis/preflight/worker',
        context => handlePOST(request, context),
    );
}
