// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.webhooks;

import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.INVALID_SECRET;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.INVALID_TIMESTAMP;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.MISSING_HEADERS;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.NO_MATCHING_SIGNATURE;
import static com.kindgi.client.webhooks.WebhookVerificationException.Reason.TIMESTAMP_OUT_OF_TOLERANCE;

import com.kindgi.client.KindgiJson;
import com.kindgi.client.models.WebhookEvent;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.StringJoiner;
import java.util.function.Function;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Verify the webhooks Kindgi sends, or sign requests in the same format.
 *
 * <p>Requests are signed in the <a href="https://www.standardwebhooks.com">Standard Webhooks</a>
 * format, symmetric variant {@code v1}:
 *
 * <pre>
 *   webhook-id:        the event id (the same on every retry)
 *   webhook-timestamp: Unix seconds when the request was signed
 *   webhook-signature: v1,&lt;base64 HMAC-SHA256&gt;, space-separated when several secrets sign
 * </pre>
 *
 * <p>The signed content is {@code {id}.{timestamp}.{body}}, with {@code body} the raw request body
 * exactly as sent. Secrets are {@code whsec_} + base64 of the key bytes. This is the Java
 * counterpart of {@code verifyWebhook} in {@code @kindgi/crypto} and {@code webhooks.verify} in the
 * Python SDK; any Standard Webhooks library verifies the same requests.
 *
 * <pre>
 *   byte[] body = readRawBody(request); // the bytes as received, never re-serialized JSON
 *   VerifiedWebhook delivery;
 *   try {
 *     delivery = Webhooks.verify(secret, request::getHeader, body);
 *   } catch (WebhookVerificationException e) {
 *     return Response.status(401);
 *   }
 *   WebhookEvent event = Webhooks.parseEvent(body);
 * </pre>
 *
 * <p>Delivery is at least once: deduplicate on {@link VerifiedWebhook#id()}.
 */
public final class Webhooks {

  /** Prefix of a webhook signing secret. */
  public static final String SECRET_PREFIX = "whsec_";

  /** The header carrying the event id. */
  public static final String ID_HEADER = "webhook-id";

  /** The header carrying the signing time, in Unix seconds. */
  public static final String TIMESTAMP_HEADER = "webhook-timestamp";

  /** The header carrying the {@code v1} signatures. */
  public static final String SIGNATURE_HEADER = "webhook-signature";

  /** How far a request's timestamp may be from the receiver's clock, by default (seconds). */
  public static final int DEFAULT_TOLERANCE_SECONDS = 300;

  /** The fewest random bytes a webhook secret may have (Standard Webhooks: 24 to 64). */
  public static final int SECRET_MIN_BYTES = 24;

  private static final String VERSION = "v1";
  private static final int SECRET_BYTES = 32;
  private static final String HMAC_ALGORITHM = "HmacSHA256";
  private static final Pattern TIMESTAMP = Pattern.compile("[0-9]{1,15}");
  private static final Pattern BASE64 = Pattern.compile("[A-Za-z0-9+/]+={0,2}");
  private static final SecureRandom RANDOM = new SecureRandom();

  private Webhooks() {}

  /**
   * Verify a received webhook, taking its headers from a map (header names match
   * case-insensitively), within {@link #DEFAULT_TOLERANCE_SECONDS} of now.
   */
  public static VerifiedWebhook verify(String secret, Map<String, String> headers, byte[] body) {
    return verify(secret, caseInsensitive(headers), body, Instant.now(), defaultTolerance());
  }

  /**
   * Verify a received webhook, taking its headers from a map (header names match
   * case-insensitively), against a given clock and tolerance.
   */
  public static VerifiedWebhook verify(
      String secret, Map<String, String> headers, byte[] body, Instant now, Duration tolerance) {
    return verify(secret, caseInsensitive(headers), body, now, tolerance);
  }

  /**
   * Verify a received webhook within {@link #DEFAULT_TOLERANCE_SECONDS} of now.
   *
   * @param headers looks up a header by its lower-case name (e.g. a servlet request's {@code
   *     getHeader}), returning its value or {@code null}
   */
  public static VerifiedWebhook verify(
      String secret, Function<String, String> headers, byte[] body) {
    return verify(secret, headers, body, Instant.now(), defaultTolerance());
  }

  /**
   * Verify a received webhook, or throw {@link WebhookVerificationException}.
   *
   * <p>The timestamp must be within {@code tolerance} of {@code now}, and at least one {@code v1}
   * signature in the header must match; the comparison is constant-time. {@code body} is the raw
   * request body, exactly as received.
   *
   * @param secret the endpoint's signing secret ({@code whsec_…})
   * @param headers looks up a header by its lower-case name, returning its value or {@code null}
   * @param body the raw request body bytes
   * @param now the receiver's clock
   * @param tolerance how far the request's timestamp may be from {@code now}, either way
   * @throws WebhookVerificationException if any check fails
   */
  public static VerifiedWebhook verify(
      String secret,
      Function<String, String> headers,
      byte[] body,
      Instant now,
      Duration tolerance) {
    Objects.requireNonNull(secret, "secret");
    Objects.requireNonNull(headers, "headers");
    Objects.requireNonNull(body, "body");
    Objects.requireNonNull(now, "now");
    Objects.requireNonNull(tolerance, "tolerance");

    String id = headerValue(headers, ID_HEADER);
    String timestampRaw = headerValue(headers, TIMESTAMP_HEADER);
    String signatureHeader = headerValue(headers, SIGNATURE_HEADER);
    if (id == null || timestampRaw == null || signatureHeader == null) {
      throw new WebhookVerificationException(MISSING_HEADERS);
    }
    if (!TIMESTAMP.matcher(timestampRaw).matches()) {
      throw new WebhookVerificationException(INVALID_TIMESTAMP);
    }
    long timestamp = Long.parseLong(timestampRaw);
    if (Math.abs(now.getEpochSecond() - timestamp) > tolerance.getSeconds()) {
      throw new WebhookVerificationException(TIMESTAMP_OUT_OF_TOLERANCE);
    }
    byte[] key = parseSecret(secret);
    if (key == null) {
      throw new WebhookVerificationException(INVALID_SECRET);
    }

    byte[] expected = hmac(key, signedContent(id, timestampRaw, body));
    for (String part : signatureHeader.split(" ", -1)) {
      int comma = part.indexOf(',');
      if (comma < 0 || !part.substring(0, comma).equals(VERSION)) {
        continue;
      }
      byte[] provided = decodeSignature(part.substring(comma + 1));
      if (provided != null && MessageDigest.isEqual(provided, expected)) {
        return new VerifiedWebhook(id, timestamp);
      }
    }
    throw new WebhookVerificationException(NO_MATCHING_SIGNATURE);
  }

  /**
   * The {@code webhook-signature} header value for a request: {@code v1,<base64>}, one signature.
   *
   * <p>For a test of a receiver, or a service of your own that sends webhooks in the same format.
   */
  public static String sign(String secret, String id, long timestamp, byte[] body) {
    return sign(List.of(secret), id, timestamp, body);
  }

  /**
   * The {@code webhook-signature} header value, one {@code v1,<base64>} per secret, space-separated.
   *
   * <p>Pass the new and the previous secret during a rotation: a receiver holding either one
   * accepts the request.
   */
  public static String sign(List<String> secrets, String id, long timestamp, byte[] body) {
    Objects.requireNonNull(secrets, "secrets");
    Objects.requireNonNull(id, "id");
    Objects.requireNonNull(body, "body");
    if (timestamp < 0) {
      throw new IllegalArgumentException("timestamp must be a non-negative integer (Unix seconds)");
    }
    List<byte[]> keys = new ArrayList<>();
    for (String one : secrets) {
      byte[] key = parseSecret(Objects.requireNonNull(one, "secret"));
      if (key == null) {
        throw new IllegalArgumentException("a webhook secret is `whsec_` + base64 of the key bytes");
      }
      keys.add(key);
    }
    if (keys.isEmpty()) {
      throw new IllegalArgumentException("at least one secret is required");
    }
    byte[] content = signedContent(id, Long.toString(timestamp), body);
    StringJoiner signatures = new StringJoiner(" ");
    for (byte[] key : keys) {
      signatures.add(VERSION + "," + Base64.getEncoder().encodeToString(hmac(key, content)));
    }
    return signatures.toString();
  }

  /** The three signed headers for a request, ready to send, in order: id, timestamp, signature. */
  public static Map<String, String> signedHeaders(
      String secret, String id, long timestamp, byte[] body) {
    return signedHeaders(List.of(secret), id, timestamp, body);
  }

  /** The three signed headers for a request, signed by every secret given. */
  public static Map<String, String> signedHeaders(
      List<String> secrets, String id, long timestamp, byte[] body) {
    String signature = sign(secrets, id, timestamp, body);
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put(ID_HEADER, id);
    headers.put(TIMESTAMP_HEADER, Long.toString(timestamp));
    headers.put(SIGNATURE_HEADER, signature);
    return headers;
  }

  /** A new random signing secret: {@code whsec_} + base64 of 32 random bytes. */
  public static String generateSecret() {
    byte[] bytes = new byte[SECRET_BYTES];
    RANDOM.nextBytes(bytes);
    return SECRET_PREFIX + Base64.getEncoder().encodeToString(bytes);
  }

  /** Whether a secret is {@code whsec_} + base64 (or the bare base64) of at least 24 bytes. */
  public static boolean isStrongSecret(String secret) {
    if (secret == null) {
      return false;
    }
    byte[] key = parseSecret(secret);
    return key != null && key.length >= SECRET_MIN_BYTES;
  }

  /**
   * The typed event in a verified request's body: one of {@link WebhookEvent}'s variants. Pass the
   * same raw body you verified; {@code parseEvent} doesn't verify.
   *
   * <p>A {@code type} this version of the client doesn't know yet reads as a {@link
   * WebhookEvent.Unrecognized} rather than failing, so a newer runtime's event doesn't break a
   * receiver — answer {@code 2xx} and ignore it. (The TypeScript and Python {@code parseEvent}
   * instead reject an unknown type; the Java client keeps every union's unknown variant.)
   *
   * @param body the raw request body bytes, as received (UTF-8 JSON)
   * @return the typed event
   * @throws com.kindgi.client.KindgiJsonException when the body isn't JSON, or is a known event
   *     type whose fields don't fit it
   */
  public static WebhookEvent parseEvent(byte[] body) {
    Objects.requireNonNull(body, "body");
    return KindgiJson.read(body, WebhookEvent.class);
  }

  private static Duration defaultTolerance() {
    return Duration.ofSeconds(DEFAULT_TOLERANCE_SECONDS);
  }

  private static Function<String, String> caseInsensitive(Map<String, String> headers) {
    Objects.requireNonNull(headers, "headers");
    Map<String, String> lower = new LinkedHashMap<>();
    for (Map.Entry<String, String> entry : headers.entrySet()) {
      if (entry.getKey() != null) {
        lower.putIfAbsent(entry.getKey().toLowerCase(Locale.ROOT), entry.getValue());
      }
    }
    return lower::get;
  }

  private static String headerValue(Function<String, String> headers, String name) {
    String value = headers.apply(name);
    return value == null || value.isEmpty() ? null : value;
  }

  private static byte[] signedContent(String id, String timestamp, byte[] body) {
    byte[] prefix = (id + "." + timestamp + ".").getBytes(StandardCharsets.UTF_8);
    byte[] content = new byte[prefix.length + body.length];
    System.arraycopy(prefix, 0, content, 0, prefix.length);
    System.arraycopy(body, 0, content, prefix.length, body.length);
    return content;
  }

  private static byte[] hmac(byte[] key, byte[] content) {
    try {
      Mac mac = Mac.getInstance(HMAC_ALGORITHM);
      mac.init(new SecretKeySpec(key, HMAC_ALGORITHM));
      return mac.doFinal(content);
    } catch (NoSuchAlgorithmException | InvalidKeyException e) {
      throw new IllegalStateException(HMAC_ALGORITHM + " is unavailable", e);
    }
  }

  /** Key bytes of a {@code whsec_…} (or bare base64) secret; {@code null} when malformed. */
  private static byte[] parseSecret(String secret) {
    String encoded = secret.startsWith(SECRET_PREFIX) ? secret.substring(SECRET_PREFIX.length()) : secret;
    if (!BASE64.matcher(encoded).matches()) {
      return null;
    }
    String padded = encoded + "=".repeat((4 - encoded.length() % 4) % 4);
    byte[] key;
    try {
      key = Base64.getDecoder().decode(padded);
    } catch (IllegalArgumentException e) {
      return null;
    }
    return key.length == 0 ? null : key;
  }

  private static byte[] decodeSignature(String encoded) {
    try {
      return Base64.getDecoder().decode(encoded);
    } catch (IllegalArgumentException e) {
      return null;
    }
  }
}
