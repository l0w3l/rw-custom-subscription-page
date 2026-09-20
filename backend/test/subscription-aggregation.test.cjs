require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    SubscriptionAggregationService,
    prioritizeSubscriptions,
    isActiveSubscription,
} = require('../src/modules/subscription/subscription-aggregation.service.ts');
const { AxiosService } = require('../src/common/axios/axios.service.ts');
const { GetUsersStreamCommand } = require('@remnawave/backend-contract');
const user = (id, overrides = {}) => ({
    id,
    shortUuid: `user-${id}`,
    username: `user-${id}`,
    status: 'ACTIVE',
    telegramId: 123,
    trafficLimitBytes: 100,
    expireAt: new Date('2099-01-01'),
    createdAt: new Date(1000 * id),
    userTraffic: { usedTrafficBytes: 10 },
    ...overrides,
});
const body = (id, server = 'host') => Buffer.from(`vless://${id}@${server}:443?security=tls#Host`);
const original = () => ({
    subscription: body('primary'),
    headers: {
        'content-type': 'text/plain',
        'profile-title': 'My subscription',
        'subscription-userinfo': 'old',
        'content-length': '100',
        etag: 'old',
    },
});
function setup(primary = user(2), users = [user(1), primary], enabled = true) {
    const calls = [];
    const axios = {
        getUserByShortUuid: async (...args) => {
            calls.push(['user', ...args]);
            return primary;
        },
        getUsersByTelegramId: async (...args) => {
            calls.push(['users', ...args]);
            return users;
        },
        getSubscription: async (...args) => {
            calls.push(['subscription', ...args]);
            return { subscription: body('secondary', 'other-host'), headers: {} };
        },
    };
    const service = new SubscriptionAggregationService(axios, { get: () => enabled });
    service.logger = { warn: () => {} };
    return { service, axios, calls };
}
const requestHeaders = { 'user-agent': 'v2rayNG', 'x-hwid': 'device' };
const run = (service, response = original()) =>
    service.aggregate(response, '127.0.0.2', 'user-2', requestHeaders);

test('active filtering excludes exhausted, expired, disabled and other Telegram accounts', () => {
    const primary = user(2);
    const users = [
        user(1),
        primary,
        user(3, { status: 'LIMITED' }),
        user(4, { status: 'DISABLED' }),
        user(5, { expireAt: new Date(0) }),
        user(6, { userTraffic: { usedTrafficBytes: 100 } }),
        user(7, { telegramId: 124 }),
        user(8, { trafficLimitBytes: 0, userTraffic: { usedTrafficBytes: 1000 } }),
    ];
    assert.deepEqual(
        prioritizeSubscriptions(users, primary).map((u) => u.id),
        [2, 1, 8],
    );
    assert.equal(isActiveSubscription(user(1, { status: 'EXPIRED' })), false);
});

test('aggregation preserves client headers, profile metadata and sums quota', async () => {
    const { service, calls } = setup();
    const result = await run(service);
    assert.equal(
        result.subscription.toString(),
        body('primary').toString() + '\n' + body('secondary', 'other-host').toString(),
    );
    assert.equal(result.headers['profile-title'], 'My subscription');
    assert.match(result.headers['subscription-userinfo'], /download=20; total=200;/);
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers['content-length'], undefined);
    assert.deepEqual(
        calls.find((c) => c[0] === 'subscription'),
        ['subscription', '127.0.0.2', 'user-1', requestHeaders, false, undefined],
    );
});

test('limited URL subscription is replaced by the first remaining active subscription', async () => {
    const { service } = setup(user(2, { status: 'LIMITED' }), [user(1)]);
    const result = await run(service);
    assert.equal(result.subscription.toString(), body('secondary', 'other-host').toString());
    assert.match(result.headers['subscription-userinfo'], /download=10; total=100;/);
});

test('disabled feature, missing Telegram ID, disabled URL and HWID denial preserve original response', async () => {
    for (const primary of [
        user(2, { telegramId: null }),
        user(2, { telegramId: 0 }),
        user(2, { status: 'DISABLED' }),
    ]) {
        const { service, calls } = setup(primary);
        const source = original();
        assert.equal(await run(service, source), source);
        assert.equal(calls.length, 1);
    }
    for (const [enabled, headers] of [
        [false, {}],
        [true, { 'x-hwid-limit': 'true' }],
    ]) {
        const { service, calls } = setup(undefined, undefined, enabled);
        const source = original();
        Object.assign(source.headers, headers);
        assert.equal(await run(service, source), source);
        assert.equal(calls.length, 0);
    }
});

test('lookup, subscription and format failures fall back without leaking partial configuration', async () => {
    for (const failure of ['lookup', 'fetch', 'format', 'hwid']) {
        const { service, axios } = setup();
        if (failure === 'lookup')
            axios.getUsersByTelegramId = async () => {
                throw new Error('unavailable');
            };
        if (failure === 'fetch') axios.getSubscription = async () => null;
        if (failure === 'format')
            axios.getSubscription = async () => ({
                subscription: Buffer.from('<html>error</html>'),
                headers: {},
            });
        if (failure === 'hwid')
            axios.getSubscription = async () => ({
                subscription: body('secondary'),
                headers: { 'x-hwid-limit': 'true' },
            });
        const source = original();
        assert.equal(await run(service, source), source);
    }
});

test('explicit client type is forwarded and unlimited account makes aggregate unlimited', async () => {
    const { service, calls } = setup(user(2), [user(1, { trafficLimitBytes: 0 })]);
    const result = await service.aggregate(original(), 'ip', 'user-2', requestHeaders, 'clash');
    assert.deepEqual(calls.find((c) => c[0] === 'subscription').slice(-2), [true, 'clash']);
    assert.match(result.headers['subscription-userinfo'], /total=0;/);
});

// Create complete API fixtures accepted by the installed Remnawave response schema.
function apiUser(id, telegramId = 123) {
    const date = '2099-01-01T00:00:00.000Z';
    return {
        ...user(id),
        telegramId,
        expireAt: date,
        createdAt: date,
        updatedAt: date,
        trafficLimitStrategy: 'NO_RESET',
        email: null,
        description: null,
        tag: null,
        hwidDeviceLimit: null,
        externalSquadUuid: null,
        trojanPassword: 'secret',
        vlessUuid: '11111111-1111-4111-8111-111111111111',
        ssPassword: 'secret',
        lastTriggeredThreshold: 0,
        subRevokedAt: null,
        lastTrafficResetAt: null,
        subscriptionUrl: 'https://example.com/sub/user',
        activeInternalSquads: [],
        userTraffic: {
            usedTrafficBytes: 10,
            lifetimeUsedTrafficBytes: 10,
            onlineAt: null,
            firstConnectedAt: null,
            lastConnectedNodeUuid: null,
        },
    };
}

test('API lookup paginates exact Telegram filter and discards foreign records', async () => {
    const calls = [];
    const service = Object.create(AxiosService.prototype);
    service.axiosInstance = {
        request: async (request) => {
            calls.push(request);
            return {
                data: {
                    response:
                        calls.length === 1
                            ? {
                                  users: [apiUser(1), apiUser(7, 456)],
                                  hasMore: true,
                                  nextCursor: '7',
                              }
                            : { users: [apiUser(8)], hasMore: false, nextCursor: null },
                },
            };
        },
    };
    assert.deepEqual(
        (await service.getUsersByTelegramId('ip', 123)).map((u) => u.id),
        [1, 8],
    );
    assert.equal(calls[0].url, GetUsersStreamCommand.url);
    assert.equal(calls[0].params.telegramId, '123');
    assert.equal(calls[1].params.cursor, '7');
});

test('API rejects repeated pagination cursor', async () => {
    const service = Object.create(AxiosService.prototype);
    service.axiosInstance = {
        request: async () => ({
            data: { response: { users: [], hasMore: true, nextCursor: '7' } },
        }),
    };
    await assert.rejects(service.getUsersByTelegramId('ip', 123), /cursor/);
});
