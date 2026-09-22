import { Request, Response } from 'express';

import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { TRequestTemplateTypeKeys } from '@remnawave/backend-contract';

import { AxiosService } from '@common/axios/axios.service';

import { describeAggregationError } from './aggregation-error';
import { applyHostPriorities } from './host-priority';
import { SubscriptionAggregationService } from './subscription-aggregation.service';

@Injectable()
export class SubscriptionService {
    private readonly logger = new Logger(SubscriptionService.name);

    constructor(
        private readonly axiosService: AxiosService,
        private readonly aggregationService: SubscriptionAggregationService,
    ) {}

    public async serveSubscriptionPage(
        clientIp: string,
        req: Request,
        res: Response,
        shortUuid: string,
        clientType?: TRequestTemplateTypeKeys,
    ): Promise<void> {
        try {
            let subscriptionDataResponse = await this.axiosService.getSubscription(
                clientIp,
                shortUuid,
                req.headers,
                !!clientType,
                clientType,
            );

            if (!subscriptionDataResponse) {
                res.socket?.destroy();
                return;
            }

            subscriptionDataResponse = await this.aggregationService.aggregate(
                subscriptionDataResponse,
                clientIp,
                shortUuid,
                req.headers,
                clientType,
            );

            try {
                const subscription = applyHostPriorities(subscriptionDataResponse.subscription);
                if (subscription !== subscriptionDataResponse.subscription) {
                    const headers = { ...subscriptionDataResponse.headers };
                    for (const key of Object.keys(headers)) {
                        if (
                            [
                                'content-length',
                                'content-encoding',
                                'etag',
                                'last-modified',
                                'content-md5',
                                'digest',
                            ].includes(key.toLowerCase())
                        ) {
                            delete headers[key];
                        }
                    }
                    headers['cache-control'] = 'no-store';
                    subscriptionDataResponse = { subscription, headers };
                }
            } catch (error) {
                this.logger.warn(
                    'Host priority processing failed; preserving subscription ' +
                        JSON.stringify(describeAggregationError(error)),
                );
            }

            if (subscriptionDataResponse.headers) {
                res.set(subscriptionDataResponse.headers);
            }

            res.status(200).send(subscriptionDataResponse.subscription);
            return;
        } catch (error) {
            this.logger.error('Error in serveSubscriptionPage', error);

            res.socket?.destroy();
            return;
        }
    }
}
