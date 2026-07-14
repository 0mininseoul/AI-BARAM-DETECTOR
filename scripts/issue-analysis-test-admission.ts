import { randomBytes } from 'node:crypto';
import { createAnalysisTestAdmission } from '@/lib/services/analysis/test-entitlement';

interface Arguments {
    userId: string;
    targetInstagramId: string;
    idempotencyKey: string;
}

function usage(): never {
    throw new Error(
        'Usage: npm run test-admission:issue -- '
        + '--user <uuid> --target <instagram-id> --idempotency-key <16-128 safe chars>'
    );
}

function parseArguments(argv: string[]): Arguments {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || !value || value.startsWith('--')) usage();
        if (values.has(key)) usage();
        values.set(key, value);
    }
    if (
        values.size !== 3
        || !values.has('--user')
        || !values.has('--target')
        || !values.has('--idempotency-key')
    ) {
        usage();
    }
    return {
        userId: values.get('--user')!,
        targetInstagramId: values.get('--target')!,
        idempotencyKey: values.get('--idempotency-key')!,
    };
}

function main(): void {
    const input = parseArguments(process.argv.slice(2));
    const token = createAnalysisTestAdmission({
        ...input,
        nonce: randomBytes(18).toString('base64url'),
    });
    process.stdout.write(`${token}\n`);
}

main();
