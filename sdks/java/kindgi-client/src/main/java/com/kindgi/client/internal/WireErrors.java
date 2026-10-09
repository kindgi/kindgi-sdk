// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import com.kindgi.client.AuthException;
import com.kindgi.client.ConflictException;
import com.kindgi.client.GuardrailViolationException;
import com.kindgi.client.InvalidRequestException;
import com.kindgi.client.KindgiApiException;
import com.kindgi.client.NotFoundException;
import com.kindgi.client.RateLimitedException;
import com.kindgi.client.ServerException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The typed exception for a non-2xx answer ({@code {"error": {code, message, details, …}}}). The
 * categories and the codes in each are the TypeScript client's ({@code errors.ts fromWire}) and
 * the Python client's ({@code _errors.py}): keep the three in step.
 */
public final class WireErrors {
  private WireErrors() {}

  static final Set<String> NOT_FOUND =
      Set.of(
          "not-found", "run-not-found", "agent-not-found", "tool-not-found", "guardrail-not-found",
          "flow-not-found", "conversation-not-found", "approval-not-found", "reviewer-not-found",
          "proposal-not-found", "provenance-not-found", "observation-not-found", "blob-not-found",
          "audit-bundle-not-found", "signing-not-configured", "signing-key-not-found",
          "adapter-not-found", "fact-not-found", "identity-user-not-found", "provider-not-found",
          "capability-not-found", "token-not-found", "agent-version-not-found", "promotion-not-found");
  static final Set<String> CONFLICT =
      Set.of(
          "conflict", "already-terminal", "run-already-terminal", "idempotency-key-body-mismatch",
          "hitl-required", "agent-already-registered", "tool-already-registered",
          "guardrail-already-registered", "flow-already-registered", "conversation-closed",
          "provider-already-registered", "proposal-invalid-state-transition", "approval-not-decided",
          "slug-conflict", "project-default-already-exists", "registry-read-only",
          "policy-already-registered", "policy-scope-taken", "policy-scope-changed",
          "nothing-to-roll-back", "not-pinned", "agent-version-live", "eval-suite-already-registered",
          "mcp-endpoint-already-registered", "identity-provider-already-registered",
          "version-already-exists", "eval-run-already-terminal", "approval-already-decided",
          "judge-class-name-taken", "promotion-superseded", "gate-policy-already-registered",
          "gate-policy-scope-taken", "gate-policy-scope-changed", "gate-policy-scope-unpinned",
          "gate-policy-needs-pin", "gate-policy-descendant-unpinned");
  static final Set<String> INVALID =
      Set.of(
          "invalid-request", "validation-failed", "unknown-field", "bad-input", "unresolved-tool",
          "unresolved-guardrail", "schema-validation-failed", "invalid-agent", "invalid-tool-definition",
          "invalid-schema", "unknown-effect", "invalid-guardrail", "invalid-provider",
          "supervisor-header-missing", "scope-invalid");
  static final Map<String, AuthException.Reason> AUTH =
      Map.of(
          "auth-missing", AuthException.Reason.UNAUTHENTICATED,
          "auth-expired", AuthException.Reason.TOKEN_EXPIRED,
          "auth-revoked", AuthException.Reason.UNAUTHENTICATED,
          "permission-denied", AuthException.Reason.FORBIDDEN);
  private static final List<String> ID_FIELDS =
      List.of("agentId", "toolId", "runId", "adapterId", "userId", "providerId", "capabilityId", "tokenId", "factId", "guardrailId", "id");
  // 409 and 422 aren't here: a code this client doesn't list stays a ServerException (the docs
  // match `budget-exceeded`, `agent-version-mismatch` by serverCode()).
  private static final Map<Integer, String> BY_STATUS =
      Map.of(404, "not-found", 410, "not-found", 400, "invalid", 401, "auth", 403, "auth", 429, "rate-limited");

  /**
   * The exception for a non-2xx answer.
   *
   * @param body the parsed body, or {@code null}
   * @param status the HTTP status
   * @param retryAfter the {@code Retry-After} header
   * @return the exception
   */
  public static KindgiApiException fromWire(@Nullable Object body, int status, @Nullable String retryAfter) {
    Object inner = body instanceof Map ? ((Map<?, ?>) body).get("error") : null;
    if (!(inner instanceof Map)) {
      return new ServerException("HTTP " + status + " without a recognizable error body", status, "unknown", null, null);
    }
    Map<?, ?> error = (Map<?, ?>) inner;
    String code = text(error.get("code"));
    if (code == null) {
      code = "unknown";
    }
    String message = text(error.get("message"));
    if (message == null) {
      message = "Server error: " + code;
    }
    Map<String, Object> details = stringMap(error.get("details"));
    String requestId = text(error.get("requestId"));
    switch (family(code, status)) {
      case "auth":
        AuthException.Reason reason;
        if (code.equals("auth")) {
          Object r = error.get("reason");
          reason =
              "forbidden".equals(r)
                  ? AuthException.Reason.FORBIDDEN
                  : "token-expired".equals(r) ? AuthException.Reason.TOKEN_EXPIRED : AuthException.Reason.UNAUTHENTICATED;
        } else {
          reason = AUTH.getOrDefault(code, status == 403 ? AuthException.Reason.FORBIDDEN : AuthException.Reason.UNAUTHENTICATED);
        }
        return new AuthException(message, reason, status, code, details, requestId);
      case "rate-limited":
        Object seconds = error.get("retryAfterSeconds");
        Double after = seconds instanceof Number ? ((Number) seconds).doubleValue() : null;
        if (after == null && retryAfter != null && retryAfter.matches("\\d+")) {
          after = Double.valueOf(retryAfter);
        }
        return new RateLimitedException(message, after, status, code, details, requestId);
      case "not-found":
        // As Python's `code.removesuffix("-not-found") or "unknown"`.
        String kind = code.endsWith("-not-found") ? code.substring(0, code.length() - "-not-found".length()) : code;
        if (kind.isEmpty()) {
          kind = "unknown";
        }
        String id = "unknown";
        for (String field : ID_FIELDS) {
          String v = text(details.get(field));
          if (v != null) {
            id = v;
            break;
          }
        }
        return new NotFoundException(message, kind, id, status, code, details, requestId);
      case "conflict":
        return new ConflictException(message, status, code, details, requestId);
      case "invalid":
        Object issues = error.containsKey("issues") ? error.get("issues") : details.get("issues");
        return new InvalidRequestException(message, mapList(issues), status, code, details, requestId);
      case "guardrail":
        return new GuardrailViolationException(
            message, mapList(details.get("violations")), mapList(details.get("evaluationErrors")), status, code, details, requestId);
      default:
        return new ServerException(message, status, code, details, requestId);
    }
  }

  /** By the code when this client lists it, else by the status: a newer server's 404 is still not-found. */
  static String family(String code, int status) {
    if (code.equals("auth") || AUTH.containsKey(code)) {
      return "auth";
    }
    if (code.equals("rate-limited") || code.equals("rate-limit-exceeded")) {
      return "rate-limited";
    }
    if (NOT_FOUND.contains(code)) {
      return "not-found";
    }
    if (CONFLICT.contains(code)) {
      return "conflict";
    }
    if (INVALID.contains(code)) {
      return "invalid";
    }
    if (code.equals("guardrail-violation")) {
      return "guardrail";
    }
    return BY_STATUS.getOrDefault(status, "server");
  }

  private static @Nullable String text(@Nullable Object v) {
    return v instanceof String && !((String) v).isEmpty() ? (String) v : null;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> stringMap(@Nullable Object v) {
    return v instanceof Map ? (Map<String, Object>) v : Map.of();
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> mapList(@Nullable Object v) {
    List<Map<String, Object>> out = new ArrayList<>();
    if (v instanceof List) {
      for (Object item : (List<?>) v) {
        if (item instanceof Map) {
          out.add((Map<String, Object>) item);
        }
      }
    }
    return out;
  }
}
