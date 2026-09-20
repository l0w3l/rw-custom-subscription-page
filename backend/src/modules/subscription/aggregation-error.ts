import { isAxiosError } from 'axios';
import { YAMLException } from 'js-yaml';
import { ZodError } from 'zod';

// Only application-owned messages may enter logs. Never stringify a raw error:
// Axios, JSON and YAML errors can contain tokens, response bodies or proxy URLs.
const knownErrors = new Map([
    ['A subscription could not be fetched', 'subscription_unavailable'],
    ['A subscription is device restricted', 'hwid_restricted'],
    ['Subscription format mismatch', 'format_mismatch'],
    ['Invalid user pagination cursor', 'invalid_pagination_cursor'],
    ['User pagination limit exceeded', 'pagination_limit_exceeded'],
    ['Unsupported subscription links', 'unsupported_links'],
    ['Invalid VMess link', 'invalid_vmess_link'],
    ['Invalid Shadowsocks credentials', 'invalid_shadowsocks_link'],
    ['Invalid configuration list', 'invalid_configuration_list'],
    ['Invalid reference list', 'invalid_reference_list'],
    ['Missing group name', 'missing_group_name'],
    ['Invalid proxy', 'invalid_proxy'],
    ['Invalid providers', 'invalid_providers'],
    ['Invalid provider', 'invalid_provider'],
    ['Conflicting dialer proxy', 'conflicting_dialer_proxy'],
    ['Conflicting inline dialer proxy', 'conflicting_inline_dialer_proxy'],
    ['Conflicting external proxy providers', 'conflicting_external_providers'],
    ['No subscriptions to merge', 'no_subscriptions'],
]);

const safeFields = new Set([
    'response',
    'users',
    'id',
    'shortUuid',
    'status',
    'telegramId',
    'expireAt',
    'createdAt',
    'trafficLimitBytes',
    'userTraffic',
    'usedTrafficBytes',
    'nextCursor',
    'hasMore',
]);

export function describeAggregationError(error: unknown): Record<string, unknown> {
    if (isAxiosError(error)) {
        const status = error.response?.status;
        const code = error.code;
        return {
            reason: 'panel_request_failed',
            ...(typeof status === 'number' ? { httpStatus: status } : {}),
            ...(code &&
            [
                'ECONNABORTED',
                'ETIMEDOUT',
                'ECONNREFUSED',
                'ENOTFOUND',
                'EAI_AGAIN',
                'ECONNRESET',
                'ERR_NETWORK',
                'ERR_BAD_REQUEST',
                'ERR_BAD_RESPONSE',
            ].includes(code)
                ? { networkCode: code }
                : {}),
        };
    }
    if (error instanceof ZodError) {
        return {
            reason: 'invalid_panel_response',
            fields: [
                ...new Set(
                    error.issues
                        .slice(0, 8)
                        .map(
                            (issue) =>
                                issue.path
                                    .map((part) =>
                                        typeof part === 'number'
                                            ? '[]'
                                            : safeFields.has(String(part))
                                              ? String(part)
                                              : '?',
                                    )
                                    .join('.') || '$',
                        ),
                ),
            ],
        };
    }
    if (error instanceof YAMLException) return { reason: 'invalid_yaml' };
    if (error instanceof SyntaxError) return { reason: 'invalid_json' };
    if (error instanceof TypeError && 'code' in error && error.code === 'ERR_INVALID_URL') {
        return { reason: 'invalid_proxy_url' };
    }
    if (error instanceof Error && knownErrors.has(error.message)) {
        return { reason: knownErrors.get(error.message) };
    }
    return { reason: 'unexpected_error' };
}
