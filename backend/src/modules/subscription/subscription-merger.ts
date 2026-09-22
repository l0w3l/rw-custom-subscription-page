import { dump, JSON_SCHEMA, load } from 'js-yaml';

type ObjectValue = Record<string, unknown>;
export type SubscriptionFormat = 'xray-json' | 'mihomo' | 'links' | 'base64';

function object(value: unknown): value is ObjectValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Credentials differ between subscriptions; transport/security settings identify the host.
const credentials = new Set(['id', 'uuid', 'password', 'name', 'remarks', 'ps', 'tag', 'meta']);
function identity(value: unknown): string {
    function normalize(item: unknown): unknown {
        if (Array.isArray(item)) return item.map(normalize);
        if (!object(item)) return item;
        return Object.fromEntries(
            Object.keys(item)
                .sort()
                .filter((key) => !credentials.has(key))
                .map((key) => [key, normalize(item[key])]),
        );
    }
    return JSON.stringify(normalize(value));
}

function lines(text: string): string[] {
    const result = text.trim().split(/\r?\n/).filter(Boolean);
    if (
        !result.length ||
        !result.every((line) => /^(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\//.test(line))
    ) {
        throw new Error('Unsupported subscription links');
    }
    return result;
}

function linkIdentity(link: string): string {
    if (link.startsWith('vmess://')) {
        const config: unknown = JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8'));
        if (!object(config) || !config.add || !config.port) throw new Error('Invalid VMess link');
        return `vmess:${identity(config)}`;
    }
    // SSR has nested encodings; preserve distinct entries rather than guess their identity.
    if (link.startsWith('ssr://')) return link;
    let normalized = link;
    if (link.startsWith('ss://') && !link.split('#')[0].includes('@')) {
        const [encoded, fragment] = link.slice(5).split('#');
        normalized = `ss://${Buffer.from(encoded, 'base64').toString('utf8')}${fragment ? '#' + fragment : ''}`;
    }
    const url = new URL(normalized);
    let cipher = '';
    if (url.protocol === 'ss:') {
        const userInfo = decodeURIComponent(url.username);
        cipher = url.password
            ? userInfo
            : Buffer.from(userInfo, 'base64').toString('utf8').split(':')[0];
        if (!cipher) throw new Error('Invalid Shadowsocks credentials');
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    url.searchParams.sort();
    return `${url.toString()}${cipher ? `|${cipher}` : ''}`;
}

export function detectSubscriptionFormat(body: Buffer): SubscriptionFormat | null {
    const text = body.toString('utf8').trim();
    try {
        const value: unknown = JSON.parse(text);
        const configs = Array.isArray(value) ? value : [value];
        if (
            configs.every(
                (entry) =>
                    object(entry) &&
                    Array.isArray(entry.outbounds) &&
                    entry.outbounds.every(
                        (outbound: unknown) =>
                            object(outbound) && typeof outbound.protocol === 'string',
                    ),
            )
        ) {
            return 'xray-json';
        }
    } catch {
        /* Not JSON. */
    }
    try {
        const value = load(text, { schema: JSON_SCHEMA });
        if (object(value) && (Array.isArray(value.proxies) || object(value['proxy-providers'])))
            return 'mihomo';
    } catch {
        /* Not YAML. */
    }
    try {
        lines(text);
        return 'links';
    } catch {
        /* Not plain links. */
    }
    if (/^[A-Za-z0-9+/=_\s-]+$/.test(text)) {
        try {
            lines(Buffer.from(text, 'base64').toString('utf8'));
            return 'base64';
        } catch {
            /* Not encoded links. */
        }
    }
    return null;
}

function records(value: unknown): ObjectValue[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(object))
        throw new Error('Invalid configuration list');
    return value;
}

function strings(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        throw new Error('Invalid reference list');
    return value;
}

function mergeMihomo(configs: ObjectValue[]): string {
    const base = structuredClone(configs[0]);
    const proxies: ObjectValue[] = [];
    const groups = new Map<string, ObjectValue>();
    const providers = new Map<string, ObjectValue>();
    const seen = new Map<string, string>();
    const occupied = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
    for (const config of configs) {
        for (const group of records(config['proxy-groups'])) {
            if (typeof group.name !== 'string') throw new Error('Missing group name');
            occupied.add(group.name);
        }
    }
    function addProxy(
        proxy: ObjectValue,
        target: ObjectValue[],
        known: Map<string, string>,
        names: Set<string>,
    ): string {
        if (typeof proxy.name !== 'string' || typeof proxy.type !== 'string')
            throw new Error('Invalid proxy');
        const key = identity(proxy);
        const existing = known.get(key);
        if (existing) return existing;
        let name = proxy.name;
        let suffix = 2;
        while (names.has(name)) name = `${proxy.name} (${suffix++})`;
        names.add(name);
        known.set(key, name);
        target.push({ ...proxy, name });
        return name;
    }
    for (const config of configs) {
        const names = new Map<string, string>();
        for (const proxy of records(config.proxies)) {
            const name = addProxy(proxy, proxies, seen, occupied);
            if (typeof proxy.name === 'string') names.set(proxy.name, name);
        }
        // Reject ambiguous dialer references rather than silently changing a chain.
        for (const proxy of proxies) {
            if (typeof proxy['dialer-proxy'] === 'string' && names.has(proxy['dialer-proxy'])) {
                // Ambiguous cross-subscription chains must not silently change credentials.
                if (names.get(proxy['dialer-proxy']) !== proxy['dialer-proxy'])
                    throw new Error('Conflicting dialer proxy');
            }
        }
        if (config['proxy-providers'] !== undefined) {
            if (!object(config['proxy-providers'])) throw new Error('Invalid providers');
            for (const [name, raw] of Object.entries(config['proxy-providers'])) {
                if (!object(raw)) throw new Error('Invalid provider');
                const existing = providers.get(name);
                if (!existing) providers.set(name, structuredClone(raw));
                else if (Array.isArray(existing.payload) && Array.isArray(raw.payload)) {
                    const payload: ObjectValue[] = [];
                    const known = new Map<string, string>();
                    const used = new Set<string>();
                    const source = [...records(existing.payload), ...records(raw.payload)];
                    const renamed = new Set<string>();
                    for (const proxy of source) {
                        const finalName = addProxy(proxy, payload, known, used);
                        if (finalName !== proxy.name) renamed.add(String(proxy.name));
                    }
                    if (
                        source.some(
                            (proxy) =>
                                typeof proxy['dialer-proxy'] === 'string' &&
                                renamed.has(proxy['dialer-proxy']),
                        )
                    ) {
                        throw new Error('Conflicting inline dialer proxy');
                    }
                    existing.payload = payload;
                } else if (JSON.stringify(existing) !== JSON.stringify(raw)) {
                    throw new Error('Conflicting external proxy providers');
                }
            }
        }
        for (const group of records(config['proxy-groups'])) {
            const name = String(group.name);
            const refs = strings(group.proxies).map((ref) => names.get(ref) ?? ref);
            const existing = groups.get(name);
            if (!existing)
                groups.set(name, {
                    ...group,
                    ...(group.proxies !== undefined ? { proxies: [...new Set(refs)] } : {}),
                });
            else {
                if (existing.proxies !== undefined || refs.length)
                    existing.proxies = [...new Set([...strings(existing.proxies), ...refs])];
                if (group.use !== undefined)
                    existing.use = [...new Set([...strings(existing.use), ...strings(group.use)])];
            }
        }
    }
    base.proxies = proxies;
    if (groups.size) base['proxy-groups'] = [...groups.values()];
    if (providers.size) base['proxy-providers'] = Object.fromEntries(providers);
    return dump(base, { noRefs: true, lineWidth: -1, schema: JSON_SCHEMA });
}

export function mergeSubscriptionBodies(bodies: Buffer[], format: SubscriptionFormat): Buffer {
    if (!bodies.length) throw new Error('No subscriptions to merge');
    if (bodies.some((body) => detectSubscriptionFormat(body) !== format))
        throw new Error('Subscription format mismatch');
    if (format === 'mihomo') {
        return Buffer.from(
            mergeMihomo(
                bodies.map(
                    (body) => load(body.toString('utf8'), { schema: JSON_SCHEMA }) as ObjectValue,
                ),
            ),
        );
    }
    if (format === 'xray-json') {
        const result: ObjectValue[] = [];
        for (const body of bodies) {
            const parsed = JSON.parse(body.toString('utf8'));
            // Each profile is a complete configuration with its own routing and chains.
            // Shared outbounds do not make profiles interchangeable; preserve every profile.
            result.push(...records(Array.isArray(parsed) ? parsed : [parsed]));
        }
        return Buffer.from(JSON.stringify(result));
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const body of bodies) {
        const text =
            format === 'base64'
                ? Buffer.from(body.toString('utf8'), 'base64').toString('utf8')
                : body.toString('utf8');
        for (const link of lines(text)) {
            const key = linkIdentity(link);
            if (!seen.has(key)) {
                seen.add(key);
                result.push(link);
            }
        }
    }
    const text = result.join('\n');
    return Buffer.from(format === 'base64' ? Buffer.from(text).toString('base64') : text);
}
