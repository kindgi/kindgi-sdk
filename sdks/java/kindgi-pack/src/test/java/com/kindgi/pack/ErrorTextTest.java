// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.kindgi.log.Causes;
import com.kindgi.log.Redaction;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.UnaryOperator;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/**
 * What a thrown error says in a failed call's answer: the shared error-text vectors ({@code
 * packages/log/tests/vectors/error-text.json}, which {@code @kindgi/log} and Python's {@code
 * kindgi.log} replay too), and the call's values taken out first.
 */
class ErrorTextTest {
  private static final Path VECTORS = Path.of("../../../packages/log/tests/vectors/error-text.json");
  private static final String SECRET = "shop-key-0123456789";
  private static final String OTHER = "acme-pass-9876";
  private static final String TOKEN = "ya29.acme-token";

  /** An error the vectors name: its simple name is the vector's, and {@code code()} its code. */
  abstract static class Named extends RuntimeException {
    private static final long serialVersionUID = 1L;
    private final @Nullable String code;

    Named(String message, @Nullable Throwable cause, @Nullable String code) {
      // Its cause is set only when it has one, so a test can still set it later (a cycle).
      super(message);
      if (cause != null) {
        initCause(cause);
      }
      this.code = code;
    }

    public @Nullable String code() {
      return code;
    }
  }

  static final class ToolError extends Named {
    private static final long serialVersionUID = 1L;

    ToolError(String message, @Nullable Throwable cause, @Nullable String code) {
      super(message, cause, code);
    }
  }

  static final class ConnectError extends Named {
    private static final long serialVersionUID = 1L;

    ConnectError(String message, @Nullable Throwable cause, @Nullable String code) {
      super(message, cause, code);
    }
  }

  static final class SocketError extends Named {
    private static final long serialVersionUID = 1L;

    SocketError(String message, @Nullable Throwable cause, @Nullable String code) {
      super(message, cause, code);
    }
  }

  static final class TimeoutError extends Named {
    private static final long serialVersionUID = 1L;

    TimeoutError(String message, @Nullable Throwable cause, @Nullable String code) {
      super(message, cause, code);
    }
  }

  static final class LookupError extends Named {
    private static final long serialVersionUID = 1L;

    LookupError(String message, @Nullable Throwable cause, @Nullable String code) {
      super(message, cause, code);
    }
  }

  private static Throwable errorOf(JsonNode spec) {
    Throwable cause = spec.has("cause") ? errorOf(spec.get("cause")) : null;
    String message = spec.get("message").asText();
    String code = spec.has("code") ? spec.get("code").asText() : null;
    return switch (spec.get("name").asText()) {
      case "ToolError" -> new ToolError(message, cause, code);
      case "ConnectError" -> new ConnectError(message, cause, code);
      case "SocketError" -> new SocketError(message, cause, code);
      case "TimeoutError" -> new TimeoutError(message, cause, code);
      case "LookupError" -> new LookupError(message, cause, code);
      default -> throw new IllegalArgumentException("no error class for " + spec.get("name"));
    };
  }

  private static JsonNode vectors() throws IOException {
    return new ObjectMapper().readTree(VECTORS.toFile());
  }

  @Test
  void theFullMaskMasksAsTheSharedVectorsSay() throws IOException {
    JsonNode cases = vectors().get("scrub");
    assertThat(cases.size()).isPositive();
    for (JsonNode c : cases) {
      assertThat(Redaction.scrubText(c.get("text").asText(), true)).as(c.get("name").asText())
          .isEqualTo(c.get("expected").asText());
    }
  }

  @Test
  void theCausesAreSaidAsTheSharedVectorsSay() throws IOException {
    JsonNode cases = vectors().get("causes");
    assertThat(cases.size()).isPositive();
    for (JsonNode c : cases) {
      assertThat(Causes.describe(errorOf(c.get("error")))).as(c.get("name").asText())
          .isEqualTo(c.get("expected").asText());
    }
  }

  @Test
  void anErrorMetASecondTimeEndsTheWalk() {
    ToolError top = new ToolError("lookup failed", null, null);
    ConnectError below = new ConnectError("Connection refused", top, null);
    top.initCause(below);
    assertThat(Causes.describe(top)).isEqualTo("; caused by ConnectError: Connection refused");
  }

  @Test
  void theMessageIsMaskedAndSaysItsCauses() {
    Throwable e = new IllegalStateException("lookup failed for kgi_sk_ABCDEFGHIJKLMNOPQRSTUV",
        new IOException("GET https://api.acme.example/v1?token=abc123 refused"));
    assertThat(ErrorText.said(e, UnaryOperator.identity())).isEqualTo("java.lang.IllegalStateException: lookup failed for "
        + "[redacted]; caused by IOException: GET https://api.acme.example/v1?token=[redacted] refused");
  }

  @Test
  void aWrappingErrorDoesNotSayItsCauseTwice() {
    Throwable e = new RuntimeException(new IOException("disk full"));
    assertThat(ErrorText.said(e, UnaryOperator.identity())).isEqualTo("java.lang.RuntimeException: java.io.IOException: disk full");
  }

  private static ToolContext context() {
    ToolConnection mail = new ToolConnection("c-1", "google", "Google", TOKEN,
        new ConnectionAccount("g-1", "ana@acme.example"), null, null);
    return ToolContext.forTest(new ToolContext.Builder()
        .withSecrets(Map.of("SHOP_KEY", SECRET, "OTHER", OTHER, "PIN", "123", "LIMIT", 12345))
        .withConnections(Map.of("mail", mail)));
  }

  @Test
  void theCallsTokenAndSecretsAreTakenOut() {
    UnaryOperator<String> without = ErrorText.withoutValues(context());
    assertThat(without.apply("sent " + TOKEN + " and " + SECRET + " to the store"))
        .isEqualTo("sent [redacted] and [redacted] to the store");
  }

  @Test
  void aSecretTooShortOrNotAStringIsPassedOver() {
    UnaryOperator<String> without = ErrorText.withoutValues(context());
    assertThat(without.apply("PIN 123, limit 12345")).isEqualTo("PIN 123, limit 12345");
  }

  @Test
  void aSecretAsAJsonStringWritesItIsTakenOut() {
    String secret = "line one\n\"quoted\"";
    UnaryOperator<String> without = ErrorText.withoutValues(
        ToolContext.forTest(new ToolContext.Builder().withSecrets(Map.of("NOTE", secret))));
    assertThat(without.apply("body {\"note\":\"line one\\n\\\"quoted\\\"\"} refused"))
        .isEqualTo("body {\"note\":\"[redacted]\"} refused");
  }

  @Test
  void aSecretsFirstPartIsTakenOutUpToWhereTheTextStops() {
    String key = "-----BEGIN KEY-----\nMIIEowIBAAKCAQEA\n-----END KEY-----";
    UnaryOperator<String> without = ErrorText.withoutValues(
        ToolContext.forTest(new ToolContext.Builder().withSecrets(Map.of("KEY", key))));
    assertThat(without.apply("bad key -----BEGIN KEY-----\nMIIEow")).isEqualTo("bad key [redacted]");
    assertThat(without.apply("bad key -----BEGIN KEY-----\nMIIEowIBAAKCAQEA\nnext line"))
        .isEqualTo("bad key [redacted]\nnext line");
  }

  @Test
  void secretsThatTouchBecomeOneRedacted() {
    UnaryOperator<String> without = ErrorText.withoutValues(context());
    assertThat(without.apply("sent " + SECRET + OTHER)).isEqualTo("sent [redacted]");
  }

  @Test
  void theValuesGoBeforeTheOneLineSoAKeyOfSeveralLinesGoesWhole() {
    String key = "-----BEGIN KEY-----\nMIIEowIBAAKCAQEA\n-----END KEY-----";
    UnaryOperator<String> without = ErrorText.withoutValues(
        ToolContext.forTest(new ToolContext.Builder().withSecrets(Map.of("KEY", key))));
    Throwable e = new IllegalStateException("lookup failed", new IOException("bad key " + key));
    assertThat(ErrorText.said(e, without))
        .isEqualTo("java.lang.IllegalStateException: lookup failed; caused by IOException: bad key [redacted]");
  }

  @Test
  void theValuesGoBeforeTheCutSoNoPartShows() {
    String phrase = "open sesame for the shop";
    UnaryOperator<String> without = ErrorText.withoutValues(
        ToolContext.forTest(new ToolContext.Builder().withSecrets(Map.of("PHRASE", phrase))));
    // Cut first, the cause would keep "open sesame for", which no match on the whole phrase finds.
    Throwable e = new IllegalStateException("lookup failed", new IOException("x".repeat(470) + " " + phrase));
    String said = ErrorText.said(e, without);
    assertThat(said).doesNotContain("sesame");
    assertThat(said).isEqualTo("java.lang.IllegalStateException: lookup failed; caused by IOException: "
        + "x".repeat(470) + " [redacted]");
  }

  @Test
  void theCauseFieldHasTheValuesTakenOut() {
    UnaryOperator<String> without = ErrorText.withoutValues(context());
    Throwable e = new IllegalStateException("lookup failed with " + SECRET, new IOException("token " + TOKEN));
    Map<String, Object> cause = ErrorText.cause(e, without);
    assertThat(cause).containsEntry("name", "java.lang.IllegalStateException")
        .containsEntry("message", "lookup failed with [redacted]");
    assertThat((String) cause.get("stack")).contains("Caused by: java.io.IOException: token [redacted]")
        .doesNotContain(SECRET).doesNotContain(TOKEN);
  }
}
