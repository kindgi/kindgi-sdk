// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.client.AuthException;
import com.kindgi.client.ConflictException;
import com.kindgi.client.GuardrailViolationException;
import com.kindgi.client.InvalidRequestException;
import com.kindgi.client.KindgiApiException;
import com.kindgi.client.NotFoundException;
import com.kindgi.client.RateLimitedException;
import com.kindgi.client.ServerException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The same cases as the Python client's tests/test_errors.py. */
class WireErrorsTest {
  private static Map<String, Object> wire(Map<String, Object> error) {
    return Map.of("error", error);
  }

  @Test
  void notFoundNamesTheKindAndTheId() {
    KindgiApiException e =
        WireErrors.fromWire(wire(Map.of("code", "run-not-found", "message", "no run", "details", Map.of("runId", "r1"), "requestId", "q1")), 404, null);
    assertThat(e).isInstanceOfSatisfying(NotFoundException.class, n -> {
      assertThat(n.kind()).isEqualTo("run");
      assertThat(n.id()).isEqualTo("r1");
    });
    assertThat(e.code()).isEqualTo("not-found");
    assertThat(e.serverCode()).isEqualTo("run-not-found");
    assertThat(e.status()).isEqualTo(404);
    assertThat(e.requestId()).isEqualTo("q1");
    assertThat(e.getMessage()).isEqualTo("no run");
  }

  @Test
  void aNewerServersCodeFallsBackToItsStatus() {
    assertThat(WireErrors.fromWire(wire(Map.of("code", "org-not-found", "message", "m")), 404, null)).isInstanceOf(NotFoundException.class);
    assertThat(WireErrors.fromWire(wire(Map.of("code", "budget-exceeded", "message", "m")), 409, null)).isInstanceOf(ServerException.class);
    assertThat(WireErrors.fromWire(wire(Map.of("code", "something-new", "message", "m")), 400, null)).isInstanceOf(InvalidRequestException.class);
  }

  @Test
  void conflictsAuthAndRateLimits() {
    assertThat(WireErrors.fromWire(wire(Map.of("code", "already-terminal", "message", "m")), 409, null)).isInstanceOf(ConflictException.class);
    assertThat(WireErrors.fromWire(wire(Map.of("code", "permission-denied", "message", "m")), 403, null))
        .isInstanceOfSatisfying(AuthException.class, a -> assertThat(a.reason()).isEqualTo(AuthException.Reason.FORBIDDEN));
    assertThat(WireErrors.fromWire(wire(Map.of("code", "auth", "reason", "token-expired", "message", "m")), 401, null))
        .isInstanceOfSatisfying(AuthException.class, a -> assertThat(a.reason()).isEqualTo(AuthException.Reason.TOKEN_EXPIRED));
    assertThat(WireErrors.fromWire(wire(Map.of("code", "rate-limited", "message", "m")), 429, "7"))
        .isInstanceOfSatisfying(RateLimitedException.class, r -> assertThat(r.retryAfterSeconds()).isEqualTo(7.0));
    assertThat(WireErrors.fromWire(wire(Map.of("code", "rate-limited", "message", "m", "retryAfterSeconds", 2.5)), 429, "7"))
        .isInstanceOfSatisfying(RateLimitedException.class, r -> assertThat(r.retryAfterSeconds()).isEqualTo(2.5));
  }

  @Test
  void invalidRequestsAndGuardrailsCarryTheirLists() {
    assertThat(
            WireErrors.fromWire(
                wire(Map.of("code", "validation-failed", "message", "m", "issues", List.of(Map.of("path", "agent", "message", "required")))), 400, null))
        .isInstanceOfSatisfying(InvalidRequestException.class, i -> assertThat(i.issues()).hasSize(1));
    assertThat(
            WireErrors.fromWire(
                wire(Map.of("code", "guardrail-violation", "message", "m", "details", Map.of("violations", List.of(Map.of("guardrailId", "g"))))), 422, null))
        .isInstanceOfSatisfying(GuardrailViolationException.class, g -> {
          assertThat(g.violations()).hasSize(1);
          assertThat(g.evaluationErrors()).isEmpty();
        });
  }

  @Test
  void aBodyWithoutAnErrorIsAServerError() {
    KindgiApiException e = WireErrors.fromWire(null, 502, null);
    assertThat(e).isInstanceOf(ServerException.class);
    assertThat(e.serverCode()).isEqualTo("unknown");
    assertThat(e.getMessage()).isEqualTo("HTTP 502 without a recognizable error body");
  }
}
