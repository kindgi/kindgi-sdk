// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EventId, Page, SubscriptionId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  Event,
  EventListFilter,
  EventSpec,
  Subscription,
  SubscriptionSpec,
} from '../types.js';

/**
 * Events resource — emit, subscribe, query.
 *
 * Events are the causal glue between runs. Filters are declarative
 * predicates (data, not code). Delivery at-least-once with idempotent
 * handlers. Two shapes: trigger-a-new-run (see `client.eventTriggers`)
 * OR a run waiting inside a node handler (`ctx.waitForToken` in
 * `@kindgi/handler`, not surfaced by the SDK).
 *
 * **No API routes.** There is no `packages/api/src/routes/events.ts`:
 * the runtime has an event bus, but the subscription-scoped surface
 * (emit / subscribe / list / get / delete / query / stream) has no HTTP
 * routes, so every method throws `not-yet-wired`.
 *
 * `stream(subscriptionId)` — the SDK-side SSE reader (`readSse`) exists;
 * what the API lacks is a `GET /v1/events/subscriptions/{id}/stream`
 * route mapping a subscription's matched events onto SSE frames. For
 * live run-scoped events use `client.runs.stream(runId)`.
 */
export interface EventsClient {
  /**
   * @unwired The API has no `POST /v1/events` route.
   */
  emit(spec: EventSpec): Promise<EventId>;

  /**
   * @unwired The API has no `POST /v1/events/subscriptions` route.
   */
  subscribe(spec: SubscriptionSpec): Promise<SubscriptionId>;

  readonly subscriptions: SubscriptionsClient;

  /**
   * @unwired The API has no `GET /v1/events/subscriptions/{id}/stream`
   *   route. The SDK-side SSE reader (`readSse`, also used by
   *   `runs.stream`) exists; the HTTP path from subscription matches to
   *   SSE frames does not.
   *
   *   For live run-scoped events use `client.runs.stream(runId)`.
   */
  stream(subscriptionId: SubscriptionId): AsyncIterable<Event>;

  /**
   * @unwired The API has no `GET /v1/events` route for event history.
   */
  query(filter?: EventListFilter): Promise<Page<Event>>;
}

export interface SubscriptionsClient {
  /**
   * @unwired The API has no `GET /v1/events/subscriptions` route.
   */
  list(): Promise<Page<Subscription>>;

  /**
   * @unwired The API has no `GET /v1/events/subscriptions/{id}` route.
   */
  get(id: SubscriptionId): Promise<Subscription>;

  /**
   * @unwired The API has no `DELETE /v1/events/subscriptions/{id}` (or
   *   `POST .../unregister`) route.
   */
  delete(id: SubscriptionId): Promise<void>;
}

export function makeEventsClient(_transport: Transport): EventsClient {
  return {
    async emit(_spec) {
      throw new KindgiApiError(
        notYetWired(
          'events.emit',
          'no POST /v1/events route on the API — outbound event-emit surface has not landed (runtime event-bus primitive is live; HTTP surface pending)',
        ),
      );
    },

    async subscribe(_spec) {
      throw new KindgiApiError(
        notYetWired(
          'events.subscribe',
          'no POST /v1/events/subscriptions route on the API — subscription registration surface has not landed',
        ),
      );
    },

    subscriptions: {
      async list() {
        throw new KindgiApiError(
          notYetWired(
            'events.subscriptions.list',
            'no GET /v1/events/subscriptions route on the API',
          ),
        );
      },
      async get(_id) {
        throw new KindgiApiError(
          notYetWired(
            'events.subscriptions.get',
            'no GET /v1/events/subscriptions/{id} route on the API',
          ),
        );
      },
      async delete(_id) {
        throw new KindgiApiError(
          notYetWired(
            'events.subscriptions.delete',
            'no DELETE /v1/events/subscriptions/{id} route on the API',
          ),
        );
      },
    },

    stream(_subscriptionId) {
      // SDK-side SSE reader is ready (`readSse`);
      // the wire lacks a `GET /v1/events/subscriptions/{id}/stream`
      // route. `notYetWired` — the server is the blocker, not the SDK.
      const iter: AsyncIterable<Event> = {
        // eslint-disable-next-line @typescript-eslint/require-await
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Event>> {
              return Promise.reject(
                new KindgiApiError(
                  notYetWired(
                    'events.stream',
                    'no GET /v1/events/subscriptions/{id}/stream route on the API — subscription-scoped SSE surface has not landed (runtime event bus is live; SDK-side SSE reader is ready via readSse; HTTP route pending). Use client.runs.stream(runId) for live run-scoped events.',
                  ),
                ),
              );
            },
          };
        },
      };
      return iter;
    },

    async query(_filter) {
      throw new KindgiApiError(
        notYetWired(
          'events.query',
          'no GET /v1/events route on the API — event-history query surface has not landed',
        ),
      );
    },
  };
}
