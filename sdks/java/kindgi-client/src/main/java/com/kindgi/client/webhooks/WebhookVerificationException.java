// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.webhooks;

/**
 * A received request isn't a webhook signed with the given secret; {@link #reason()} says which
 * check failed. Catch it and answer {@code 401}.
 *
 * <p>Unchecked, like {@link com.kindgi.client.KindgiJsonException}: the verifier is a library call,
 * not the HTTP client. A caller that lets it propagate rejects the request by failing the handler.
 */
public final class WebhookVerificationException extends RuntimeException {

  /** Which check {@link Webhooks#verify} failed on. The names match the TypeScript and Python verifiers. */
  public enum Reason {
    /** A required header ({@code webhook-id}, {@code webhook-timestamp} or {@code webhook-signature}) was absent or empty. */
    MISSING_HEADERS("missing-headers"),
    /** {@code webhook-timestamp} isn't a Unix-seconds integer. */
    INVALID_TIMESTAMP("invalid-timestamp"),
    /** The timestamp is further than the tolerance from the receiver's clock. */
    TIMESTAMP_OUT_OF_TOLERANCE("timestamp-out-of-tolerance"),
    /** The secret isn't {@code whsec_} + base64 of the key bytes. */
    INVALID_SECRET("invalid-secret"),
    /** No {@code v1} signature in the header matched. */
    NO_MATCHING_SIGNATURE("no-matching-signature");

    private final String wire;

    Reason(String wire) {
      this.wire = wire;
    }

    /** The reason string, the same literal the TypeScript and Python verifiers use. */
    public String wireValue() {
      return wire;
    }

    @Override
    public String toString() {
      return wire;
    }
  }

  private final Reason reason;

  WebhookVerificationException(Reason reason) {
    super(reason.wireValue());
    this.reason = reason;
  }

  /** Which check failed. */
  public Reason reason() {
    return reason;
  }
}
