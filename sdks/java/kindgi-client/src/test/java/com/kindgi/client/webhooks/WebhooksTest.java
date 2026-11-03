// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.webhooks;

import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.INVALID_SECRET;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.INVALID_TIMESTAMP;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.MISSING_HEADERS;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.NO_MATCHING_SIGNATURE;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.TIMESTAMP_OUT_OF_TOLERANCE;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.KindgiJsonException;
import com.kindgi.client.models.RunFinishedEvent;
import com.kindgi.client.models.WebhookEvent;
import com.kindgi.client.models.WebhookTestEvent;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * {@link Webhooks} held to the same cases as {@code @kindgi/crypto} and the Python {@code
 * kindgi.webhooks}: the Standard Webhooks test vector and the edge cases around it read alike in
 * the three languages.
 */
class WebhooksTest {
  // The test vector published with the Standard Webhooks specification (the same one the crypto
  // and Python SDKs' tests use).
  private static final String SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  private static final String MSG_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  private static final long TIMESTAMP = 1614265330L;
  private static final byte[] BODY = "{\"test\": 2432232314}".getBytes(UTF_8);
  private static final String SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
  private static final Instant AT_VECTOR = Instant.ofEpochSecond(TIMESTAMP);
  private static final Duration DEFAULT_TOLERANCE =
      Duration.ofSeconds(Webhooks.DEFAULT_TOLERANCE_SECONDS);

  // --- sign -----------------------------------------------------------------

  @Test
  void signMatchesTheStandardWebhooksVector() {
    assertThat(Webhooks.sign(SECRET, MSG_ID, TIMESTAMP, BODY)).isEqualTo(SIGNATURE);
  }

  @Test
  void signedHeadersCarryAllThree() {
    assertThat(Webhooks.signedHeaders(SECRET, MSG_ID, TIMESTAMP, BODY)).isEqualTo(vectorHeaders());
  }

  @Test
  void signsOncePerSecretDuringARotation() {
    String[] parts =
        Webhooks.sign(List.of(Webhooks.generateSecret(), SECRET), MSG_ID, TIMESTAMP, BODY)
            .split(" ");
    assertThat(parts).hasSize(2);
    assertThat(parts[1]).isEqualTo(SIGNATURE);
  }

  @Test
  void signRefusesAMalformedSecretABadTimestampAndNoSecrets() {
    assertThatThrownBy(() -> Webhooks.sign("whsec_not base64!", MSG_ID, TIMESTAMP, BODY))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("whsec_");
    assertThatThrownBy(() -> Webhooks.sign(SECRET, MSG_ID, -1, BODY))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("non-negative integer");
    assertThatThrownBy(() -> Webhooks.sign(List.<String>of(), MSG_ID, TIMESTAMP, BODY))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("at least one secret");
  }

  // --- verify ---------------------------------------------------------------

  @Test
  void verifyAcceptsTheVector() {
    VerifiedWebhook verified = Webhooks.verify(SECRET, vectorHeaders(), BODY, AT_VECTOR, DEFAULT_TOLERANCE);
    assertThat(verified).isEqualTo(new VerifiedWebhook(MSG_ID, TIMESTAMP));
  }

  @Test
  void headerNamesMatchInAnyCase() {
    Map<String, String> titleCase = new LinkedHashMap<>();
    titleCase.put("Webhook-Id", MSG_ID);
    titleCase.put("Webhook-Timestamp", Long.toString(TIMESTAMP));
    titleCase.put("Webhook-Signature", SIGNATURE);
    assertThat(Webhooks.verify(SECRET, titleCase, BODY, AT_VECTOR, DEFAULT_TOLERANCE).id())
        .isEqualTo(MSG_ID);
  }

  @Test
  void aChangedBodyIdOrSecretFails() {
    assertThat(failure(SECRET, vectorHeaders(), "{\"test\": 2432232315}".getBytes(UTF_8)))
        .isEqualTo(NO_MATCHING_SIGNATURE);
    Map<String, String> otherId = vectorHeaders();
    otherId.put(Webhooks.ID_HEADER, "msg_other");
    assertThat(failure(SECRET, otherId, BODY)).isEqualTo(NO_MATCHING_SIGNATURE);
    assertThat(failure(Webhooks.generateSecret(), vectorHeaders(), BODY))
        .isEqualTo(NO_MATCHING_SIGNATURE);
  }

  @Test
  void theToleranceHoldsInEitherDirection() {
    for (long offset : new long[] {-301, 301}) {
      assertThat(failureAt(vectorHeaders(), Instant.ofEpochSecond(TIMESTAMP + offset), DEFAULT_TOLERANCE))
          .isEqualTo(TIMESTAMP_OUT_OF_TOLERANCE);
    }
    for (long offset : new long[] {-300, 300}) {
      assertThat(
              Webhooks.verify(
                      SECRET, vectorHeaders(), BODY, Instant.ofEpochSecond(TIMESTAMP + offset), DEFAULT_TOLERANCE)
                  .id())
          .isEqualTo(MSG_ID);
    }
    assertThat(
            Webhooks.verify(
                    SECRET,
                    vectorHeaders(),
                    BODY,
                    Instant.ofEpochSecond(TIMESTAMP + 3600),
                    Duration.ofSeconds(3600))
                .id())
        .isEqualTo(MSG_ID);
  }

  @Test
  void missingOrEmptyHeadersAndAMalformedTimestampAreReported() {
    Map<String, String> noSignature = vectorHeaders();
    noSignature.remove(Webhooks.SIGNATURE_HEADER);
    assertThat(failure(SECRET, noSignature, BODY)).isEqualTo(MISSING_HEADERS);

    Map<String, String> emptyId = vectorHeaders();
    emptyId.put(Webhooks.ID_HEADER, "");
    assertThat(failure(SECRET, emptyId, BODY)).isEqualTo(MISSING_HEADERS);

    for (String bad : new String[] {"16142e5", "-1614265330", "١٦١٤٢٦٥٣٣٠", "1".repeat(16)}) {
      Map<String, String> headers = vectorHeaders();
      headers.put(Webhooks.TIMESTAMP_HEADER, bad);
      assertThat(failure(SECRET, headers, BODY)).isEqualTo(INVALID_TIMESTAMP);
    }
  }

  @Test
  void aMalformedSecretIsReported() {
    for (String secret : new String[] {"whsec_", "whsec_not base64!", "", "whsec_A"}) {
      assertThat(failure(secret, vectorHeaders(), BODY)).isEqualTo(INVALID_SECRET);
    }
  }

  @Test
  void eitherSecretVerifiesDuringARotation() {
    String fresh = Webhooks.generateSecret();
    Map<String, String> rotated =
        Webhooks.signedHeaders(List.of(fresh, SECRET), MSG_ID, TIMESTAMP, BODY);
    for (String secret : new String[] {fresh, SECRET}) {
      assertThat(Webhooks.verify(secret, rotated, BODY, AT_VECTOR, DEFAULT_TOLERANCE).id())
          .isEqualTo(MSG_ID);
    }
  }

  @Test
  void unknownVersionsAndMalformedSignaturesAreSkipped() {
    String decoys =
        "v1a,AAAA v1 v1,not-base64! v1,"
            + Base64.getEncoder().encodeToString("x".repeat(32).getBytes(UTF_8));
    Map<String, String> withDecoys = vectorHeaders();
    withDecoys.put(Webhooks.SIGNATURE_HEADER, decoys + " " + SIGNATURE);
    assertThat(Webhooks.verify(SECRET, withDecoys, BODY, AT_VECTOR, DEFAULT_TOLERANCE).id())
        .isEqualTo(MSG_ID);

    Map<String, String> onlyUnknown = vectorHeaders();
    onlyUnknown.put(Webhooks.SIGNATURE_HEADER, SIGNATURE.replace("v1,", "v2,"));
    assertThat(failure(SECRET, onlyUnknown, BODY)).isEqualTo(NO_MATCHING_SIGNATURE);
  }

  @Test
  void verifyUsesTheClockByDefault() {
    long now = Instant.now().getEpochSecond();
    Map<String, String> headers = Webhooks.signedHeaders(SECRET, MSG_ID, now, BODY);
    assertThat(Webhooks.verify(SECRET, headers, BODY).timestamp()).isEqualTo(now);
  }

  // --- secrets --------------------------------------------------------------

  @Test
  void isStrongSecretWants24BytesWithOrWithoutThePrefix() {
    String b24 = Base64.getEncoder().encodeToString(filled(24));
    String b23 = Base64.getEncoder().encodeToString(filled(23));
    assertThat(Webhooks.isStrongSecret("whsec_" + b24)).isTrue();
    assertThat(Webhooks.isStrongSecret(b24)).isTrue();
    assertThat(Webhooks.isStrongSecret("whsec_" + b23)).isFalse();
    assertThat(Webhooks.isStrongSecret(Webhooks.generateSecret())).isTrue();
    assertThat(Webhooks.isStrongSecret("password123")).isFalse();
    assertThat(Webhooks.isStrongSecret("whsec_")).isFalse();
  }

  @Test
  void generateSecretIsWhsecAnd32RandomBytes() {
    String a = Webhooks.generateSecret();
    String b = Webhooks.generateSecret();
    assertThat(a).startsWith(Webhooks.SECRET_PREFIX);
    assertThat(Base64.getDecoder().decode(a.substring(Webhooks.SECRET_PREFIX.length()))).hasSize(32);
    assertThat(a).isNotEqualTo(b);
  }

  // --- parseEvent -----------------------------------------------------------

  @Test
  void parseEventReadsRunFinished() {
    byte[] body =
        """
        {
          "id": "5c6f0d2e-0000-4000-8000-000000000001",
          "type": "run.finished",
          "createdAt": "2026-10-02T00:00:00.000Z",
          "data": {
            "run": {
              "id": "2b1e9c4a-0000-4000-8000-000000000002",
              "projectId": "7d3f5a10-0000-4000-8000-000000000003",
              "flowId": "acme.order-review",
              "flowVersion": "1.0.0",
              "status": "failed",
              "dryRun": false,
              "failureMessage": "the model call failed",
              "createdAt": "2026-10-01T23:59:00.000Z",
              "completedAt": "2026-10-02T00:00:00.000Z"
            }
          }
        }
        """
            .getBytes(UTF_8);

    WebhookEvent event = Webhooks.parseEvent(body);

    assertThat(event).isInstanceOf(RunFinishedEvent.class);
    RunFinishedEvent run = (RunFinishedEvent) event;
    assertThat(run.data().run().flowId()).isEqualTo("acme.order-review");
    assertThat(run.data().run().status()).isEqualTo(com.kindgi.client.models.FinishedRun.Status.FAILED);
    assertThat(run.data().run().failureMessage()).isEqualTo("the model call failed");
    assertThat(run.data().run().failure()).isNull();
    assertThat(run.createdAt().toInstant()).isEqualTo(Instant.parse("2026-10-02T00:00:00Z"));
  }

  @Test
  void parseEventReadsTheTestEvent() {
    byte[] body =
        """
        {
          "id": "evt-test",
          "type": "webhook.test",
          "createdAt": "2026-10-02T00:00:00.000Z",
          "data": { "endpointId": "ep-1" }
        }
        """
            .getBytes(UTF_8);

    WebhookEvent event = Webhooks.parseEvent(body);

    assertThat(event).isInstanceOf(WebhookTestEvent.class);
    assertThat(((WebhookTestEvent) event).data().endpointId()).isEqualTo("ep-1");
  }

  @Test
  void parseEventKeepsAnUnknownTypeAsUnrecognized() {
    // A newer runtime's event type doesn't break a receiver: it reads as Unrecognized, not an
    // error (where the TypeScript and Python parseEvent reject it). Answer 2xx and ignore it.
    byte[] body =
        """
        {
          "id": "evt-new",
          "type": "run.started",
          "createdAt": "2026-10-02T00:00:00.000Z",
          "data": {}
        }
        """
            .getBytes(UTF_8);

    WebhookEvent event = Webhooks.parseEvent(body);

    assertThat(event).isInstanceOf(WebhookEvent.Unrecognized.class);
    assertThat(event.type()).isEqualTo("run.started");
  }

  @Test
  void parseEventRejectsAKnownTypeThatDoesNotFit() {
    // run.finished with the required data.run.status missing.
    byte[] body =
        """
        {
          "id": "5c6f0d2e-0000-4000-8000-000000000001",
          "type": "run.finished",
          "createdAt": "2026-10-02T00:00:00.000Z",
          "data": {
            "run": {
              "id": "2b1e9c4a-0000-4000-8000-000000000002",
              "projectId": "7d3f5a10-0000-4000-8000-000000000003",
              "flowId": "acme.order-review",
              "flowVersion": "1.0.0",
              "dryRun": false,
              "createdAt": "2026-10-01T23:59:00.000Z",
              "completedAt": "2026-10-02T00:00:00.000Z"
            }
          }
        }
        """
            .getBytes(UTF_8);

    assertThatThrownBy(() -> Webhooks.parseEvent(body)).isInstanceOf(KindgiJsonException.class);
  }

  // --- helpers --------------------------------------------------------------

  private static Map<String, String> vectorHeaders() {
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put(Webhooks.ID_HEADER, MSG_ID);
    headers.put(Webhooks.TIMESTAMP_HEADER, Long.toString(TIMESTAMP));
    headers.put(Webhooks.SIGNATURE_HEADER, SIGNATURE);
    return headers;
  }

  private static WebhookVerificationException.Reason failure(
      String secret, Map<String, String> headers, byte[] body) {
    try {
      Webhooks.verify(secret, headers, body, AT_VECTOR, DEFAULT_TOLERANCE);
    } catch (WebhookVerificationException e) {
      return e.reason();
    }
    throw new AssertionError("expected verification to fail");
  }

  private static WebhookVerificationException.Reason failureAt(
      Map<String, String> headers, Instant now, Duration tolerance) {
    try {
      Webhooks.verify(SECRET, headers, BODY, now, tolerance);
    } catch (WebhookVerificationException e) {
      return e.reason();
    }
    throw new AssertionError("expected verification to fail");
  }

  private static byte[] filled(int length) {
    byte[] bytes = new byte[length];
    Arrays.fill(bytes, (byte) 7);
    return bytes;
  }
}
