import type { IncomingHttpHeaders } from 'node:http';

import { Injectable, Logger } from '@nestjs/common';

import { GetUserByShortUuidCommand, TRequestTemplateTypeKeys } from '@remnawave/backend-contract';

import { AxiosService } from '@common/axios/axios.service';
import { TypedConfigService } from '@common/config/app-config';

import { detectSubscriptionFormat, mergeSubscriptionBodies } from './subscription-merger';

type User = GetUserByShortUuidCommand.Response['response'];
type Subscription = NonNullable<Awaited<ReturnType<AxiosService['getSubscription']>>>;

function isDeviceBlocked(subscription: Subscription): boolean {
    return Object.entries(subscription.headers).some(
        ([name, value]) =>
            ['x-hwid-limit', 'x-hwid-not-supported', 'x-hwid-max-devices-reached'].includes(
                name.toLowerCase(),
            ) && String(value).toLowerCase() === 'true',
    );
}

export function isActiveSubscription(user: User, now = Date.now()): boolean {
    return (
        user.status === 'ACTIVE' &&
        new Date(user.expireAt).getTime() > now &&
        (user.trafficLimitBytes === 0 || user.userTraffic.usedTrafficBytes < user.trafficLimitBytes)
    );
}

export function prioritizeSubscriptions(users: User[], primary: User, now = Date.now()): User[] {
    const unique = new Map(users.map((user) => [user.shortUuid, user]));
    unique.set(primary.shortUuid, primary);
    return [...unique.values()]
        .filter((user) => user.telegramId === primary.telegramId && isActiveSubscription(user, now))
        .sort((a, b) => {
            if (a.shortUuid === primary.shortUuid) return -1;
            if (b.shortUuid === primary.shortUuid) return 1;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id;
        });
}

@Injectable()
export class SubscriptionAggregationService {
    private readonly logger = new Logger(SubscriptionAggregationService.name);

    constructor(
        private readonly axiosService: AxiosService,
        private readonly configService: TypedConfigService,
    ) {}

    public async aggregate(
        original: Subscription,
        clientIp: string,
        shortUuid: string,
        headers: IncomingHttpHeaders,
        clientType?: TRequestTemplateTypeKeys,
    ): Promise<Subscription> {
        if (!this.configService.get('TELEGRAM_SUBSCRIPTION_MERGE_ENABLED')) return original;
        if (isDeviceBlocked(original)) return original;
        const format = detectSubscriptionFormat(original.subscription);
        if (!format) return original;

        try {
            const primary = await this.axiosService.getUserByShortUuid(clientIp, shortUuid);
            if (
                primary.shortUuid !== shortUuid ||
                primary.status === 'DISABLED' ||
                !Number.isSafeInteger(primary.telegramId) ||
                !primary.telegramId ||
                primary.telegramId < 0
            )
                return original;
            const users = prioritizeSubscriptions(
                await this.axiosService.getUsersByTelegramId(clientIp, primary.telegramId),
                primary,
            );
            if (!users.length || (users.length === 1 && users[0].shortUuid === shortUuid))
                return original;

            const subscriptions: Subscription[] = [];
            // Sequential fetches bound panel load and preserve the priority order.
            for (const user of users) {
                const subscription =
                    user.shortUuid === shortUuid
                        ? original
                        : await this.axiosService.getSubscription(
                              clientIp,
                              user.shortUuid,
                              headers,
                              !!clientType,
                              clientType,
                          );
                if (!subscription) throw new Error('A subscription could not be fetched');
                if (isDeviceBlocked(subscription))
                    throw new Error('A subscription is device restricted');
                subscriptions.push(subscription);
            }
            const subscription = mergeSubscriptionBodies(
                subscriptions.map((entry) => entry.subscription),
                format,
            );
            const resultHeaders = { ...original.headers };
            for (const name of Object.keys(resultHeaders)) {
                if (
                    [
                        'content-length',
                        'content-encoding',
                        'etag',
                        'last-modified',
                        'content-md5',
                        'digest',
                        'subscription-userinfo',
                    ].includes(name.toLowerCase())
                ) {
                    delete resultHeaders[name];
                }
            }
            // These describe all included accounts, not just the URL's account.
            const used = users.reduce((sum, user) => sum + user.userTraffic.usedTrafficBytes, 0);
            const total = users.some((user) => user.trafficLimitBytes === 0)
                ? 0
                : users.reduce((sum, user) => sum + user.trafficLimitBytes, 0);
            const expire = Math.floor(
                Math.max(...users.map((user) => new Date(user.expireAt).getTime())) / 1000,
            );
            resultHeaders['subscription-userinfo'] =
                `upload=0; download=${used}; total=${total}; expire=${expire}`;
            resultHeaders['cache-control'] = 'no-store';
            return { subscription, headers: resultHeaders };
        } catch {
            // Do not log Axios errors: they can contain API tokens and subscription credentials.
            this.logger.warn(
                'Subscription aggregation failed; returning the original panel response',
            );
            return original;
        }
    }
}
