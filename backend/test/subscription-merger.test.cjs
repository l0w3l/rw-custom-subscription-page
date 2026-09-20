const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dump, load } = require('js-yaml');
const {
    detectSubscriptionFormat,
    mergeSubscriptionBodies,
} = require('../src/modules/subscription/subscription-merger.ts');
const buf = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
const xray = (address, id, remarks = address) => ({
    remarks,
    dns: { servers: ['1.1.1.1'] },
    routing: { rules: [{ outboundTag: 'proxy' }] },
    outbounds: [
        {
            tag: 'proxy',
            protocol: 'vless',
            settings: {
                vnext: [{ address, port: 443, users: [{ id, flow: 'xtls-rprx-vision' }] }],
            },
        },
        { tag: 'direct', protocol: 'freedom' },
    ],
});

test('Xray keeps first credentials, whole templates and distinct endpoints', () => {
    const first = xray('a.example', 'first', 'same');
    const second = xray('a.example', 'second', 'other name');
    const extra = xray('b.example', 'second', 'same');
    const result = JSON.parse(
        mergeSubscriptionBodies([buf([first]), buf([second, extra])], 'xray-json'),
    );
    assert.deepEqual(result, [first, extra]);
});

test('Xray transport/flow variants remain separate', () => {
    const first = xray('a.example', 'first');
    const second = xray('a.example', 'second');
    second.outbounds[0].settings.vnext[0].users[0].flow = '';
    assert.equal(
        JSON.parse(mergeSubscriptionBodies([buf([first]), buf([second])], 'xray-json')).length,
        2,
    );
});

test('plain and base64 URI subscriptions preserve first credentials and transport variants', () => {
    const first = 'vless://first@a.example:443?security=tls&type=ws#A';
    const second = 'vless://second@a.example:443?type=ws&security=tls#B';
    const extra = 'vless://second@a.example:443?security=tls&type=grpc#C';
    for (const format of ['links', 'base64']) {
        const encode = (s) => buf(format === 'base64' ? buf(s).toString('base64') : s);
        const result = mergeSubscriptionBodies(
            [encode(first), encode(second + '\n' + extra)],
            format,
        ).toString();
        assert.equal(
            format === 'base64' ? Buffer.from(result, 'base64').toString() : result,
            first + '\n' + extra,
        );
    }
});

test('VMess credentials and remarks are excluded from identity', () => {
    const encode = (id, ps) =>
        'vmess://' +
        buf({ v: '2', add: 'host', port: '443', id, ps, net: 'ws', tls: 'tls' }).toString('base64');
    const first = encode('first', 'first name');
    assert.equal(
        mergeSubscriptionBodies([buf(first), buf(encode('second', 'other'))], 'links').toString(),
        first,
    );
});

test('Mihomo deduplicates hosts, renames colliding names and updates group references', () => {
    const proxy = (name, server, uuid) => ({
        name,
        server,
        uuid,
        type: 'vless',
        port: 443,
        tls: true,
    });
    const first = {
        proxies: [proxy('A', 'a.example', 'first')],
        'proxy-groups': [{ name: 'select', type: 'select', proxies: ['A', 'DIRECT'] }],
        rules: ['MATCH,select'],
        dns: { enable: true },
    };
    const second = {
        proxies: [proxy('renamed', 'a.example', 'second'), proxy('A', 'b.example', 'second')],
        'proxy-groups': [{ name: 'select', type: 'select', proxies: ['renamed', 'A', 'DIRECT'] }],
    };
    const merged = load(
        mergeSubscriptionBodies([buf(dump(first)), buf(dump(second))], 'mihomo').toString(),
    );
    assert.deepEqual(merged.proxies, [
        proxy('A', 'a.example', 'first'),
        proxy('A (2)', 'b.example', 'second'),
    ]);
    assert.deepEqual(merged['proxy-groups'][0].proxies, ['A', 'DIRECT', 'A (2)']);
    assert.deepEqual(merged.rules, first.rules);
    assert.deepEqual(merged.dns, first.dns);
});

test('Mihomo inline providers merge with first credentials', () => {
    const make = (uuid, server) => ({
        'proxy-providers': {
            local: {
                type: 'inline',
                payload: [{ name: 'host', type: 'vless', server, port: 443, uuid }],
            },
        },
        'proxy-groups': [{ name: 'select', type: 'select', use: ['local'] }],
    });
    const result = load(
        mergeSubscriptionBodies(
            [
                buf(dump(make('first', 'a'))),
                buf(dump(make('second', 'a'))),
                buf(dump(make('third', 'b'))),
            ],
            'mihomo',
        ).toString(),
    );
    assert.equal(result['proxy-providers'].local.payload.length, 2);
    assert.equal(result['proxy-providers'].local.payload[0].uuid, 'first');
    assert.equal(result['proxy-providers'].local.payload[1].name, 'host (2)');
});

test('unknown, encrypted, Sing-box and mismatched formats cannot be merged', () => {
    for (const input of [
        '<html>denied</html>',
        'happ://crypt/secret',
        '{"outbounds":[{"type":"vless"}]}',
    ])
        assert.equal(detectSubscriptionFormat(buf(input)), null);
    assert.throws(() =>
        mergeSubscriptionBodies(
            [buf([xray('a', 'id')]), buf('vless://id@host:443#A')],
            'xray-json',
        ),
    );
});

test('empty Xray arrays can be replaced by active profiles', () => {
    const profile = xray('host', 'active');
    assert.deepEqual(JSON.parse(mergeSubscriptionBodies([buf([]), buf([profile])], 'xray-json')), [
        profile,
    ]);
});

test('Shadowsocks preserves cipher variants while preferring first password', () => {
    const encode = (cipher, password) =>
        `ss://${Buffer.from(`${cipher}:${password}`).toString('base64')}@host:443#Name`;
    const first = encode('aes-128-gcm', 'first');
    const same = encode('aes-128-gcm', 'second');
    const different = encode('chacha20-ietf-poly1305', 'second');
    assert.equal(
        mergeSubscriptionBodies([buf(first), buf(same + '\n' + different)], 'links').toString(),
        first + '\n' + different,
    );
});

test('conflicting external providers are rejected instead of silently discarding hosts', () => {
    const make = (url) =>
        buf(
            dump({
                proxies: [],
                'proxy-providers': { remote: { type: 'http', url, path: './remote.yaml' } },
            }),
        );
    assert.throws(
        () =>
            mergeSubscriptionBodies(
                [make('https://one.example'), make('https://two.example')],
                'mihomo',
            ),
        /Conflicting external/,
    );
});

test('Mihomo renamed chain targets cannot silently point at the first account', () => {
    const make = (server) =>
        buf(
            dump({
                proxies: [
                    { name: 'hop', type: 'vless', server, port: 443, uuid: 'id' },
                    {
                        name: 'exit',
                        type: 'vless',
                        server: 'exit',
                        port: 443,
                        uuid: 'id',
                        'dialer-proxy': 'hop',
                    },
                ],
            }),
        );
    assert.throws(() => mergeSubscriptionBodies([make('one'), make('two')], 'mihomo'), /dialer/);
});
