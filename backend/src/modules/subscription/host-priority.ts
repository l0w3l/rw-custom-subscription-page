import { dump, JSON_SCHEMA, load } from 'js-yaml';

import { detectSubscriptionFormat } from './subscription-merger';

type Config = Record<string, unknown>;
const DEFAULT_PRIORITY = 1000;

function object(value: unknown): value is Config {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseHostPriority(value: unknown): {
    name: string;
    priority: number;
    marked: boolean;
} {
    const name = typeof value === 'string' ? value : '';
    const match = /^\[P(\d+)\]\s*(.+)$/u.exec(name);
    if (match && Number.isSafeInteger(Number(match[1])) && match[2].trim()) {
        return { name: match[2].trim(), priority: Number(match[1]), marked: true };
    }
    return { name, priority: DEFAULT_PRIORITY, marked: false };
}

function configs(value: unknown): Config[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(object))
        throw new Error('Invalid configuration list');
    return value;
}

function prioritizeMihomo(config: Config): boolean {
    const proxies = configs(config.proxies);
    const groups = configs(config['proxy-groups']);
    const providers = object(config['proxy-providers'])
        ? Object.values(config['proxy-providers'])
        : [];
    const lists = [
        proxies,
        ...providers
            .filter(object)
            .filter((provider) => Array.isArray(provider.payload))
            .map((provider) => configs(provider.payload)),
    ];
    const hosts = lists.flat();
    if (!hosts.some((host) => parseHostPriority(host.name).marked)) return false;

    // Reserve unmarked names and group names before allocating cleaned host names.
    const occupied = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
    for (const group of groups) if (typeof group.name === 'string') occupied.add(group.name);
    for (const host of hosts) {
        if (typeof host.name !== 'string') throw new Error('Invalid proxy');
        if (!parseHostPriority(host.name).marked) occupied.add(host.name);
    }
    const renamed = new Map<string, string>();
    const priorities = new Map<string, number>();
    const hostPriorities = new Map<Config, number>();
    for (const host of hosts) {
        const original = String(host.name);
        const { name, priority, marked } = parseHostPriority(original);
        if (!renamed.has(original)) {
            let unique = name;
            let suffix = 2;
            while (marked && occupied.has(unique)) unique = `${name} (${suffix++})`;
            occupied.add(unique);
            renamed.set(original, unique);
            priorities.set(unique, priority);
        }
        host.name = renamed.get(original)!;
        hostPriorities.set(host, priority);
    }
    for (const list of lists) list.sort((a, b) => hostPriorities.get(a)! - hostPriorities.get(b)!);

    for (const group of groups) {
        if (group.proxies === undefined) continue;
        if (
            !Array.isArray(group.proxies) ||
            !group.proxies.every((ref) => typeof ref === 'string')
        ) {
            throw new Error('Invalid reference list');
        }
        const refs = (group.proxies as string[]).map((ref) => renamed.get(ref) ?? ref);
        // A relay list is a chain of hops, not a menu: changing its order changes routing.
        if (group.type !== 'relay')
            refs.sort(
                (a, b) =>
                    (priorities.get(a) ?? DEFAULT_PRIORITY) -
                    (priorities.get(b) ?? DEFAULT_PRIORITY),
            );
        group.proxies = refs;
    }

    // Update references, never arbitrary substrings in endpoints, passwords or regexes.
    function renameReferences(value: unknown): void {
        if (Array.isArray(value)) {
            value.forEach(renameReferences);
            return;
        }
        if (!object(value)) return;
        for (const [key, child] of Object.entries(value)) {
            if (key === 'dialer-proxy' && typeof child === 'string')
                value[key] = renamed.get(child) ?? child;
            else renameReferences(child);
        }
    }
    renameReferences(config);
    for (const value of [...providers, ...configs(config.tunnels)]) {
        if (object(value) && typeof value.proxy === 'string')
            value.proxy = renamed.get(value.proxy) ?? value.proxy;
    }
    function renameRules(value: unknown): void {
        if (!Array.isArray(value)) return;
        for (let i = 0; i < value.length; i++) {
            if (typeof value[i] !== 'string') continue;
            const parts = value[i].split(',');
            if (parts[0].trim() === 'SUB-RULE') continue;
            const index =
                parts.at(-1)?.trim() === 'no-resolve' ? parts.length - 2 : parts.length - 1;
            if (index > 0 && renamed.has(parts[index].trim())) {
                parts[index] = renamed.get(parts[index].trim())!;
                value[i] = parts.join(',');
            }
        }
    }
    renameRules(config.rules);
    if (object(config['sub-rules'])) Object.values(config['sub-rules']).forEach(renameRules);
    return true;
}

function prioritizeLink(link: string): { link: string; priority: number; marked: boolean } {
    if (link.startsWith('vmess://')) {
        const config: unknown = JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8'));
        if (!object(config)) throw new Error('Invalid VMess link');
        const parsed = parseHostPriority(config.ps);
        if (parsed.marked) config.ps = parsed.name;
        return {
            ...parsed,
            link: parsed.marked
                ? `vmess://${Buffer.from(JSON.stringify(config)).toString('base64')}`
                : link,
        };
    }
    // SSR remarks are nested in a different encoding; keep these opaque as in the merger.
    if (link.startsWith('ssr://')) return { link, priority: DEFAULT_PRIORITY, marked: false };
    const hash = link.indexOf('#');
    if (hash < 0) return { link, priority: DEFAULT_PRIORITY, marked: false };
    let name: string;
    try {
        name = decodeURIComponent(link.slice(hash + 1));
    } catch {
        return { link, priority: DEFAULT_PRIORITY, marked: false };
    }
    const parsed = parseHostPriority(name);
    return {
        ...parsed,
        link: parsed.marked ? link.slice(0, hash + 1) + encodeURIComponent(parsed.name) : link,
    };
}

// Run after deduplication: priority changes presentation, never the winning credentials.
// Return the original Buffer when nothing changes, preserving upstream bytes and headers.
export function applyHostPriorities(body: Buffer): Buffer {
    const format = detectSubscriptionFormat(body);
    if (!format) return body;
    if (format === 'xray-json') {
        const value: unknown = JSON.parse(body.toString('utf8'));
        const profiles = configs(Array.isArray(value) ? value : [value]);
        const entries = profiles.map((profile) => ({
            profile,
            ...parseHostPriority(profile.remarks),
        }));
        if (!entries.some((entry) => entry.marked)) return body;
        entries.sort((a, b) => a.priority - b.priority);
        for (const entry of entries) if (entry.marked) entry.profile.remarks = entry.name;
        return Buffer.from(
            JSON.stringify(
                Array.isArray(value) ? entries.map((entry) => entry.profile) : entries[0].profile,
            ),
        );
    }
    if (format === 'mihomo') {
        const config = load(body.toString('utf8'), { schema: JSON_SCHEMA }) as Config;
        if (!prioritizeMihomo(config)) return body;
        return Buffer.from(dump(config, { noRefs: true, lineWidth: -1, schema: JSON_SCHEMA }));
    }
    const text =
        format === 'base64'
            ? Buffer.from(body.toString('utf8'), 'base64').toString('utf8')
            : body.toString('utf8');
    const entries = text.trim().split(/\r?\n/).filter(Boolean).map(prioritizeLink);
    if (!entries.some((entry) => entry.marked)) return body;
    entries.sort((a, b) => a.priority - b.priority);
    const result = entries.map((entry) => entry.link).join('\n');
    return Buffer.from(format === 'base64' ? Buffer.from(result).toString('base64') : result);
}
