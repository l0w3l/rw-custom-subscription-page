require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dump, load } = require('js-yaml');
const {
    applyHostPriorities,
    parseHostPriority,
} = require('../src/modules/subscription/host-priority.ts');
const { mergeSubscriptionBodies } = require('../src/modules/subscription/subscription-merger.ts');
const { SubscriptionService } = require('../src/modules/subscription/subscription.service.ts');

const json = (value) => Buffer.from(JSON.stringify(value));
const yaml = (value) => Buffer.from(dump(value));
const profile = (remarks, address = 'host', id = 'first') => ({
    remarks,
    outbounds: [
        {
            tag: 'proxy',
            protocol: 'vless',
            settings: {
                vnext: [{ address, port: 443, users: [{ id }] }],
            },
        },
    ],
    routing: { rules: [{ outboundTag: 'proxy' }] },
    dns: { servers: ['1.1.1.1'] },
});
const proxy = (name, server = 'host') => ({
    name,
    server,
    type: 'vless',
    port: 443,
    uuid: 'secret',
});

test('markers use nonnegative safe integers, default 1000, and require a nonempty name', () => {
    assert.deepEqual(parseHostPriority('[P001] 🇩🇪 Germany'), {
        name: '🇩🇪 Germany',
        priority: 1,
        marked: true,
    });
    assert.deepEqual(parseHostPriority('[P0]Germany'), {
        name: 'Germany',
        priority: 0,
        marked: true,
    });
    for (const name of [
        'Germany',
        '[P-1] Germany',
        '[P1.5] Germany',
        '[P1]',
        '[P2]   ',
        '[P9007199254740992] Germany',
        'Germany [P1]',
        '[p1] Germany',
    ]) {
        assert.deepEqual(parseHostPriority(name), { name, priority: 1000, marked: false });
    }
});

test('Xray sorts numerically and stably, removes markers and keeps each complete profile', () => {
    const profiles = [
        profile('Plain'),
        profile('[P10] Ten'),
        profile('[P2] Two'),
        profile('[P2] Another two'),
        profile('[P2000] Last'),
    ];
    const result = JSON.parse(applyHostPriorities(json(profiles)));
    assert.deepEqual(
        result.map((item) => item.remarks),
        ['Two', 'Another two', 'Ten', 'Plain', 'Last'],
    );
    assert.deepEqual(result[0], { ...profiles[2], remarks: 'Two' });
    const single = profile('[P1] One');
    assert.deepEqual(JSON.parse(applyHostPriorities(json(single))), { ...single, remarks: 'One' });
});

test('host priority never overrides the subscription that wins deduplication', () => {
    const first = profile('[P50] First', 'same-host', 'primary-credentials');
    const second = profile('[P0] Second', 'same-host', 'secondary-credentials');
    const extra = profile('[P1] Extra', 'extra-host', 'secondary-credentials');
    const merged = mergeSubscriptionBodies([json([first]), json([second, extra])], 'xray-json');
    const result = JSON.parse(applyHostPriorities(merged));
    assert.deepEqual(result, [
        { ...extra, remarks: 'Extra' },
        { ...first, remarks: 'First' },
    ]);
});

test('URI and Base64 subscriptions preserve connection strings and handle encoded Unicode names', () => {
    const plain = 'trojan://pa%3Ass@Host.EXAMPLE:443?security=tls&type=ws#Unmarked';
    const high =
        'vless://private@host:443?type=ws&path=%2Fa%3Fb#' + encodeURIComponent('[P1] 🇩🇪 Germany');
    const low = 'ss://Y2lwaGVyOnNlY3JldA==@host:443#[P20] Netherlands';
    for (const format of ['links', 'base64']) {
        const text = [plain, low, high].join('\n');
        const input = Buffer.from(
            format === 'base64' ? Buffer.from(text).toString('base64') : text,
        );
        const output = applyHostPriorities(input).toString();
        const result = format === 'base64' ? Buffer.from(output, 'base64').toString() : output;
        assert.deepEqual(result.split('\n'), [
            high.slice(0, high.indexOf('#') + 1) + encodeURIComponent('🇩🇪 Germany'),
            low.slice(0, low.indexOf('#') + 1) + 'Netherlands',
            plain,
        ]);
    }
});

test('VMess priority comes from ps; all connection fields remain unchanged', () => {
    const config = {
        ps: '[P1] Fast',
        add: 'server',
        port: '443',
        id: 'secret',
        net: 'ws',
        path: '/ws',
    };
    const uri = 'vmess://' + json(config).toString('base64');
    const result = applyHostPriorities(Buffer.from('vless://id@host:443#Plain\n' + uri))
        .toString()
        .split('\n');
    assert.deepEqual(JSON.parse(Buffer.from(result[0].slice(8), 'base64')), {
        ...config,
        ps: 'Fast',
    });
    assert.equal(result[1], 'vless://id@host:443#Plain');
});

test('Mihomo sorting updates groups, chain references, rules, sub-rules, tunnels and providers', () => {
    const input = {
        proxies: [
            proxy('[P10] Slow'),
            { ...proxy('[P1] Fast', 'fast'), 'dialer-proxy': '[P10] Slow', password: '[P10] Slow' },
        ],
        'proxy-groups': [
            { name: 'Choose', type: 'select', proxies: ['[P10] Slow', 'DIRECT', '[P1] Fast'] },
            { name: 'Chain', type: 'relay', proxies: ['[P10] Slow', '[P1] Fast'] },
        ],
        'proxy-providers': {
            remote: { type: 'http', url: 'https://example.com/[P10] Slow', proxy: '[P1] Fast' },
        },
        rules: [
            'DOMAIN,example.com,[P10] Slow',
            'IP-CIDR,10.0.0.0/8,[P1] Fast,no-resolve',
            'MATCH,Choose',
        ],
        'sub-rules': { local: ['MATCH,[P1] Fast'] },
        tunnels: [
            {
                network: 'tcp',
                address: '127.0.0.1:1234',
                target: 'example.com:443',
                proxy: '[P10] Slow',
            },
        ],
    };
    const result = load(applyHostPriorities(yaml(input)).toString());
    assert.deepEqual(
        result.proxies.map((p) => p.name),
        ['Fast', 'Slow'],
    );
    assert.equal(result.proxies[0]['dialer-proxy'], 'Slow');
    assert.equal(result.proxies[0].password, '[P10] Slow');
    assert.deepEqual(result['proxy-groups'][0].proxies, ['Fast', 'Slow', 'DIRECT']);
    assert.deepEqual(result['proxy-groups'][1].proxies, ['Slow', 'Fast']);
    assert.deepEqual(result.rules, [
        'DOMAIN,example.com,Slow',
        'IP-CIDR,10.0.0.0/8,Fast,no-resolve',
        'MATCH,Choose',
    ]);
    assert.deepEqual(result['sub-rules'].local, ['MATCH,Fast']);
    assert.equal(result.tunnels[0].proxy, 'Slow');
    assert.equal(result['proxy-providers'].remote.proxy, 'Fast');
    assert.equal(result['proxy-providers'].remote.url, 'https://example.com/[P10] Slow');
});

test('Mihomo cleaned names cannot collide with hosts, groups or built-in targets', () => {
    const input = {
        proxies: [
            proxy('[P1] Host', 'a'),
            proxy('Host', 'b'),
            proxy('[P2] Host', 'c'),
            proxy('[P0] DIRECT', 'd'),
            proxy('[P3] Choose', 'e'),
        ],
        'proxy-groups': [
            {
                name: 'Choose',
                type: 'select',
                proxies: ['Host', '[P2] Host', '[P1] Host', '[P0] DIRECT', 'DIRECT', '[P3] Choose'],
            },
        ],
        rules: ['MATCH,[P1] Host'],
    };
    const result = load(applyHostPriorities(yaml(input)).toString());
    assert.deepEqual(
        result.proxies.map((p) => p.name),
        ['DIRECT (2)', 'Host (2)', 'Host (3)', 'Choose (2)', 'Host'],
    );
    assert.deepEqual(result['proxy-groups'][0].proxies, [
        'DIRECT (2)',
        'Host (2)',
        'Host (3)',
        'Choose (2)',
        'Host',
        'DIRECT',
    ]);
    assert.deepEqual(result.rules, ['MATCH,Host (2)']);
});

test('Mihomo inline provider payloads are sorted and renamed with valid references', () => {
    const input = {
        'proxy-providers': {
            local: { type: 'inline', payload: [proxy('[P20] Low', 'a'), proxy('[P1] High', 'b')] },
        },
        'proxy-groups': [
            { name: 'Choose', type: 'select', use: ['local'], proxies: ['[P20] Low', '[P1] High'] },
        ],
    };
    const result = load(applyHostPriorities(yaml(input)).toString());
    assert.deepEqual(
        result['proxy-providers'].local.payload.map((p) => p.name),
        ['High', 'Low'],
    );
    assert.deepEqual(result['proxy-groups'][0].proxies, ['High', 'Low']);
    assert.deepEqual(result['proxy-groups'][0].use, ['local']);
});

test('unmarked subscriptions and unsupported formats retain their exact bytes', () => {
    for (const input of [
        json([profile('Plain')]),
        json([]),
        yaml({ proxies: [proxy('Plain')] }),
        Buffer.from('vless://id@host:443#Plain\r\n'),
        Buffer.from('c3NyOi8vYmxh'),
        Buffer.from('happ://crypt/secret'),
        Buffer.from('<html>Error</html>'),
    ]) {
        assert.equal(applyHostPriorities(input), input);
    }
});

test('HTTP response sorts a single subscription after aggregation and removes stale body headers', async () => {
    const source = {
        subscription: json([profile('Plain'), profile('[P1] First')]),
        headers: {
            'content-type': 'application/json',
            'content-length': '123',
            'content-encoding': 'gzip',
            etag: 'stale',
            'subscription-userinfo': 'download=10',
            'profile-title': 'Title',
        },
    };
    const service = new SubscriptionService(
        { getSubscription: async () => source },
        { aggregate: async (response) => response },
    );
    const res = {
        set(headers) {
            this.headers = headers;
        },
        status(status) {
            this.statusCode = status;
            return this;
        },
        send(body) {
            this.body = body;
        },
    };
    await service.serveSubscriptionPage('ip', { headers: {} }, res, 'short');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
        JSON.parse(res.body).map((p) => p.remarks),
        ['First', 'Plain'],
    );
    assert.equal(res.headers['profile-title'], 'Title');
    assert.equal(res.headers['subscription-userinfo'], 'download=10');
    assert.equal(res.headers['cache-control'], 'no-store');
    for (const field of ['content-length', 'content-encoding', 'etag'])
        assert.equal(res.headers[field], undefined);
    assert.equal(source.headers.etag, 'stale');
});

test('HTTP response preserves a configuration if priority processing fails', async () => {
    const source = {
        subscription: yaml({ proxies: [proxy('[P1] First')], 'proxy-groups': 'invalid' }),
        headers: {},
    };
    const service = new SubscriptionService(
        { getSubscription: async () => source },
        { aggregate: async (response) => response },
    );
    const warnings = [];
    service.logger = { warn: (message) => warnings.push(message) };
    const res = {
        set() {},
        status() {
            return this;
        },
        send(body) {
            this.body = body;
        },
    };
    await service.serveSubscriptionPage('ip', { headers: {} }, res, 'short');
    assert.equal(res.body, source.subscription);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('secret'), false);
});
