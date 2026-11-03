// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.webhooks;

/**
 * A webhook request whose signature held.
 *
 * <p>Delivery is at least once — the same event is retried until a 2xx — so deduplicate on {@link
 * #id()}.
 *
 * @param id the event id (the {@code webhook-id} header); the same on every retry
 * @param timestamp Unix seconds when Kindgi signed the request
 */
public record VerifiedWebhook(String id, long timestamp) {}
