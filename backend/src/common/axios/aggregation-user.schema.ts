import { z } from 'zod';

// Validate only fields used by aggregation. In Remnawave 3.4.4 vlessUuid accepts
// UUIDs which the 3.1.1 SDK rejects; unrelated credentials must not block a merge.
const date = z.iso.datetime().transform((value) => new Date(value));

export const aggregationUserSchema = z.object({
    id: z.number(),
    shortUuid: z.string().min(1),
    status: z.enum(['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED']),
    telegramId: z.number().nullable(),
    expireAt: date,
    createdAt: date,
    trafficLimitBytes: z.number().nonnegative(),
    userTraffic: z.object({ usedTrafficBytes: z.number().nonnegative() }),
});

export const aggregationUserResponseSchema = z.object({ response: aggregationUserSchema });

export const aggregationUsersPageSchema = z.object({
    response: z.object({
        users: z.array(aggregationUserSchema),
        nextCursor: z.string().nullable(),
        hasMore: z.boolean(),
    }),
});

export type AggregationUser = z.infer<typeof aggregationUserSchema>;
