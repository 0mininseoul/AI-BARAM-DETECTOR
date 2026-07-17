import { describe, expect, it } from 'vitest';
import { getGrobleCheckoutUrl, readGrobleConfig } from './config';

const VALID_ENV = {
    GROBLE_BASIC_PRODUCT_ID: 'basic_product-01',
    GROBLE_STANDARD_PRODUCT_ID: 'standard_product-01',
    GROBLE_WEBHOOK_SECRET: 'current-secret',
    GROBLE_WEBHOOK_PREVIOUS_SECRET: 'previous-secret',
};

describe('Groble server configuration', () => {
    it('requires both existing product IDs and the webhook secret', () => {
        expect(() => readGrobleConfig({})).toThrow('GROBLE_BASIC_PRODUCT_ID');
        expect(() => readGrobleConfig({
            GROBLE_BASIC_PRODUCT_ID: 'basic',
            GROBLE_STANDARD_PRODUCT_ID: 'standard',
        })).toThrow('GROBLE_WEBHOOK_SECRET');
    });

    it('rejects product IDs that could alter the checkout path', () => {
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_BASIC_PRODUCT_ID: '../basic?redirect=https://example.com',
        })).toThrow('GROBLE_BASIC_PRODUCT_ID');
    });

    it('builds only allowlisted Groble payment URLs for paid plans', () => {
        const config = readGrobleConfig(VALID_ENV);

        expect(getGrobleCheckoutUrl('basic', config))
            .toBe('https://groble.im/payment/basic_product-01');
        expect(getGrobleCheckoutUrl('standard', config))
            .toBe('https://groble.im/payment/standard_product-01');
    });
});
