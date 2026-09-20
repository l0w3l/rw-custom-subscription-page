const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AxiosError } = require('axios');
const { YAMLException } = require('js-yaml');
const { describeAggregationError } = require('../src/modules/subscription/aggregation-error.ts');

test('parser diagnostics never include proxy credentials or YAML snippets', () => {
    const secret = 'vless://secret-user@private.example:443';
    for (const [error, reason] of [
        [new SyntaxError(secret), 'invalid_json'],
        [new YAMLException(secret), 'invalid_yaml'],
        [new Error(secret), 'unexpected_error'],
        [
            Object.assign(new TypeError(secret), { code: 'ERR_INVALID_URL', input: secret }),
            'invalid_proxy_url',
        ],
    ]) {
        assert.deepEqual(describeAggregationError(error), { reason });
    }
});

test('network errors expose only whitelisted codes', () => {
    assert.deepEqual(describeAggregationError(new AxiosError('secret', 'ECONNABORTED')), {
        reason: 'panel_request_failed',
        networkCode: 'ECONNABORTED',
    });
    assert.deepEqual(describeAggregationError(new AxiosError('secret', 'private-token')), {
        reason: 'panel_request_failed',
    });
});
