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
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
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
    assertThat(WireErrors.fromWire(wire(Map.of("code", "something-new", "message", "m")), 409, null))
        .isInstanceOfSatisfying(ConflictException.class, c -> assertThat(c.serverCode()).isEqualTo("something-new"));
    assertThat(WireErrors.fromWire(wire(Map.of("code", "something-new", "message", "m")), 413, null)).isInstanceOf(InvalidRequestException.class);
    // 422 stays a server error: the docs match its codes there.
    assertThat(WireErrors.fromWire(wire(Map.of("code", "budget-exceeded", "message", "m")), 422, null)).isInstanceOf(ServerException.class);
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

  private static final Path OPENAPI = Path.of(System.getProperty("kindgi.openapi", "../../../packages/api/openapi.json"));

  /** The classes a code may land in on purpose, against its status: each with its reason. */
  private static final Map<String, Class<? extends KindgiApiException>> EXCEPTIONS =
      Map.of(
          // Its own class, with the violations.
          "guardrail-violation", GuardrailViolationException.class,
          // A provider registration the adapter refuses: an invalid request, with its issues.
          "provider-config-invalid", InvalidRequestException.class);

  /** The class a documented code belongs in: its HTTP status's; 422 and 5xx are server errors. */
  private static Class<? extends KindgiApiException> expectedClass(String code, int status) {
    if (EXCEPTIONS.containsKey(code)) {
      return EXCEPTIONS.get(code);
    }
    switch (status) {
      case 400:
      case 413:
        return InvalidRequestException.class;
      case 401:
      case 403:
        return AuthException.class;
      case 404:
      case 410:
        return NotFoundException.class;
      case 409:
        return ConflictException.class;
      case 429:
        return RateLimitedException.class;
      default:
        return ServerException.class;
    }
  }

  @Test
  @SuppressWarnings("unchecked")
  void everyCodeTheApiDocumentsIsInItsStatussFamilyAndKeepsItsCode() throws IOException {
    Map<String, Object> spec = Json.mapper().readValue(OPENAPI.toFile(), Map.class);
    Map<String, Object> schemas = (Map<String, Object>) ((Map<String, Object>) spec.get("components")).get("schemas");
    Map<String, Integer> codes = (Map<String, Integer>) ((Map<String, Object>) schemas.get("WireError")).get("x-error-codes");
    assertThat(codes).hasSizeGreaterThan(100);
    List<String> wrong = new ArrayList<>();
    for (Map.Entry<String, Integer> entry : codes.entrySet()) {
      String code = entry.getKey();
      int status = entry.getValue();
      KindgiApiException e = WireErrors.fromWire(wire(Map.of("code", code, "message", "m")), status, null);
      Class<? extends KindgiApiException> expected = expectedClass(code, status);
      if (e.getClass() != expected) {
        wrong.add(code + " (" + status + "): " + e.getClass().getSimpleName() + ", not " + expected.getSimpleName());
      }
      if (!code.equals(e.serverCode())) {
        wrong.add(code + " (" + status + "): serverCode " + e.serverCode());
      }
    }
    assertThat(wrong).isEmpty();
  }
}
