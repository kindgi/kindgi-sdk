// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.exports;

import com.kindgi.client.KindgiJson;
import com.kindgi.client.exports.SignedExportVerification.CheckedAgainst;
import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.SignatureException;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * Verify the signed exports Kindgi produces: an approval's audit bundle, a run's provenance,
 * compliance evidence.
 *
 * <p>Each export is one envelope: {@code bundle} is base64 of the exact bytes that were signed (the
 * body, as sorted-key JSON), {@code signature} is base64 of the signature over those bytes, and
 * {@code publicKey} is the signing key's public half (PEM). Verifying checks those bytes; nothing is
 * re-serialized.
 *
 * <p>Two algorithms: {@code ed25519}, and {@code ecdsa-p256-sha256} (its signature IEEE P1363 {@code
 * r‖s}, 64 bytes). Any other is refused, naming it, so a newer one fails loudly here, never
 * silently.
 *
 * <p>The export's own {@code publicKey} only proves the bytes weren't changed. Pass {@code
 * trustedKeys} (the {@code publicKeyPem} values from {@code GET /v1/export-signing-keys}, or a key
 * you pinned) to know who signed them.
 *
 * <p>This is the Java counterpart of {@code verifySignedExport} in {@code @kindgi/client} and {@code
 * verify_signed_export} in Python. It checks with the JDK's own crypto, so there's nothing extra to
 * install.
 */
public final class SignedExports {

  /** The algorithms {@link #verify} checks. */
  public static final List<String> ALGORITHMS = List.of("ed25519", "ecdsa-p256-sha256");

  private static final String CANONICALIZATION = "sorted-key-json";
  private static final String BAD_SIGNATURE =
      "the signature doesn't match the bundle: it was changed, or signed with another key";

  private SignedExports() {}

  /**
   * Verify a signed export's signature against its own public key, so the bytes weren't changed.
   *
   * @param envelopeJson the export as the API answered it, as JSON
   * @return what the check found; it never throws for an export that doesn't verify
   * @throws com.kindgi.client.KindgiJsonException when {@code envelopeJson} isn't a JSON object
   */
  public static SignedExportVerification verify(String envelopeJson) {
    return verify(parse(envelopeJson), null);
  }

  /**
   * Verify a signed export's signature, and that its key is one you trust.
   *
   * @param envelopeJson the export as the API answered it, as JSON
   * @param trustedKeys the public keys (PEM) you trust; the export's key must be one of them. An
   *     empty list trusts none, so every export is refused.
   * @throws com.kindgi.client.KindgiJsonException when {@code envelopeJson} isn't a JSON object
   */
  public static SignedExportVerification verify(String envelopeJson, List<String> trustedKeys) {
    return verify(parse(envelopeJson), trustedKeys);
  }

  /**
   * Verify a signed export already parsed to a map (its fields as the API names them), against its
   * own public key.
   */
  public static SignedExportVerification verify(Map<String, Object> envelope) {
    return verify(envelope, null);
  }

  /**
   * Verify a signed export already parsed to a map, and that its key is one you trust.
   *
   * <p>A {@code null} {@code trustedKeys} checks only the export's own key; a list (even empty)
   * checks the key against the ones you trust.
   */
  public static SignedExportVerification verify(
      Map<String, Object> envelope, @Nullable List<String> trustedKeys) {
    Objects.requireNonNull(envelope, "envelope");
    String keyId = str(envelope.get("signingKeyId"));
    CheckedAgainst against =
        trustedKeys != null ? CheckedAgainst.TRUSTED_KEYS : CheckedAgainst.ITS_OWN_KEY;
    List<String> issues = new ArrayList<>();

    Object algorithm = envelope.get("algorithm");
    // ALGORITHMS is List.of(...), whose contains(null) throws; a missing or null algorithm is an
    // export that doesn't verify, not one we throw on. It falls through to the issue below.
    if (!(algorithm instanceof String named) || !ALGORITHMS.contains(named)) {
      issues.add(
          "algorithm \""
              + algorithm
              + "\" isn't one this verifier knows ("
              + String.join(", ", ALGORITHMS)
              + "): a newer verifier may check it");
    }
    Object canonicalization = envelope.get("canonicalization");
    if (!CANONICALIZATION.equals(canonicalization)) {
      issues.add("canonicalization \"" + canonicalization + "\" isn't " + CANONICALIZATION);
    }
    String pem = str(envelope.get("publicKey"));
    if (trustedKeys != null && trustedKeys.stream().noneMatch(trusted -> samePem(trusted, pem))) {
      issues.add("it was signed with key \"" + keyId + "\", which isn't one you trust");
    }
    if (!issues.isEmpty()) {
      return failed(keyId, against, issues);
    }

    byte[] data;
    byte[] signature;
    byte[] der;
    try {
      data = Base64.getDecoder().decode(str(envelope.get("bundle")));
      signature = Base64.getDecoder().decode(str(envelope.get("signature")));
      der = pemToDer(pem);
    } catch (IllegalArgumentException err) {
      issues.add("it can't be checked: " + err.getMessage());
      return failed(keyId, against, issues);
    }

    try {
      if ("ed25519".equals(algorithm)) {
        PublicKey key;
        try {
          key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
        } catch (GeneralSecurityException notEd25519) {
          issues.add("its public key isn't an Ed25519 key");
          return failed(keyId, against, issues);
        }
        if (!verifies("Ed25519", key, data, signature)) {
          issues.add(BAD_SIGNATURE);
          return failed(keyId, against, issues);
        }
      } else {
        ECPublicKey key;
        try {
          PublicKey loaded =
              KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
          if (!(loaded instanceof ECPublicKey ecKey) || !isP256(ecKey)) {
            issues.add("its public key isn't an EC P-256 key");
            return failed(keyId, against, issues);
          }
          key = ecKey;
        } catch (GeneralSecurityException notEc) {
          issues.add("its public key isn't an EC P-256 key");
          return failed(keyId, against, issues);
        }
        if (signature.length != 64) {
          issues.add("its signature is " + signature.length + " bytes, not P1363's 64");
          return failed(keyId, against, issues);
        }
        if (!verifies("SHA256withECDSAinP1363Format", key, data, signature)) {
          issues.add(BAD_SIGNATURE);
          return failed(keyId, against, issues);
        }
      }
    } catch (GeneralSecurityException err) {
      issues.add("it can't be checked: " + err.getMessage());
      return failed(keyId, against, issues);
    }

    Map<String, Object> body = parseBytes(data);
    List<String> notes = new ArrayList<>();
    // The envelope's own exportedAt isn't signed; the body's is.
    if (body.containsKey("exportedAt")
        && !Objects.equals(body.get("exportedAt"), envelope.get("exportedAt"))) {
      Object outer = envelope.get("exportedAt");
      Object signed = body.get("exportedAt");
      if (!madeByKindgi014(envelope, body)) {
        issues.add("the envelope's exportedAt (" + outer + ") isn't the signed one (" + signed + ")");
        return failed(keyId, against, issues);
      }
      notes.add(
          "made by Kindgi 0.1.4, which stamped the envelope's exportedAt separately: the signed"
              + " export time is "
              + signed
              + " (the envelope says "
              + outer
              + ")");
    }
    return new SignedExportVerification(true, keyId, against, List.of(), body, List.copyOf(notes));
  }

  private static SignedExportVerification failed(
      String keyId, CheckedAgainst against, List<String> issues) {
    return new SignedExportVerification(
        false, keyId, against, List.copyOf(issues), null, List.of());
  }

  private static boolean verifies(String algorithm, PublicKey key, byte[] data, byte[] signature)
      throws GeneralSecurityException {
    Signature verifier = Signature.getInstance(algorithm);
    verifier.initVerify(key);
    verifier.update(data);
    try {
      return verifier.verify(signature);
    } catch (SignatureException malformed) {
      // A signature the provider can't even parse (an Ed25519 one of the wrong length, say)
      // didn't sign these bytes: the same "doesn't match" Python and TypeScript report.
      return false;
    }
  }

  private static boolean isP256(ECPublicKey key) {
    try {
      AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
      params.init(new ECGenParameterSpec("secp256r1"));
      ECParameterSpec p256 = params.getParameterSpec(ECParameterSpec.class);
      return key.getParams().getCurve().equals(p256.getCurve())
          && key.getParams().getOrder().equals(p256.getOrder());
    } catch (GeneralSecurityException cantTell) {
      return false;
    }
  }

  private static byte[] pemToDer(String pem) {
    String base64 =
        pem.replaceAll("-----BEGIN [^-]+-----", "")
            .replaceAll("-----END [^-]+-----", "")
            .replaceAll("\\s", "");
    return Base64.getDecoder().decode(base64);
  }

  private static boolean madeByKindgi014(Map<String, Object> envelope, Map<String, Object> body) {
    return isJsonOne(envelope.get("bundleSchemaVersion"))
        && isJsonOne(body.get("bundleVersion"))
        && !body.containsKey("bundleSchemaVersion");
  }

  /** The JSON integer {@code 1} — not {@code true} (a bool), not {@code "1"}, not {@code 1.0}. */
  private static boolean isJsonOne(@Nullable Object value) {
    if (value instanceof Integer i) {
      return i == 1;
    }
    if (value instanceof Long l) {
      return l == 1L;
    }
    if (value instanceof BigInteger b) {
      return b.equals(BigInteger.ONE);
    }
    return false;
  }

  private static boolean samePem(String a, String b) {
    return a.replaceAll("\\s", "").equals(b.replaceAll("\\s", ""));
  }

  private static String str(@Nullable Object value) {
    return value == null ? "" : value.toString();
  }

  private static Map<String, Object> parse(String json) {
    return castToMap(KindgiJson.read(json, Map.class));
  }

  private static Map<String, Object> parseBytes(byte[] json) {
    return castToMap(KindgiJson.read(json, Map.class));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> castToMap(Object parsed) {
    return (Map<String, Object>) parsed;
  }
}
