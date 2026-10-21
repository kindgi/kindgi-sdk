// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.exports;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.kindgi.client.KindgiJson;
import com.kindgi.client.exports.SignedExportVerification.CheckedAgainst;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Mirrors the Python {@code test_exports.py}: a signed export's signature over the bytes shipped,
 * and its key against the keys you trust. The shared vectors (ed25519, ecdsa-p256-sha256,
 * unknown-algorithm, kindgi-0.1.4) are the same files the TypeScript and Python clients check.
 */
final class SignedExportsTest {

  private static final Path VECTORS =
      Path.of(
          System.getProperty(
              "kindgi.testVectors", "../../../packages/specs/test-vectors/signed-export"));

  @Test
  void aSignedExportVerifiesAgainstItsOwnKeyAndReturnsTheBody() throws Exception {
    Map<String, Object> envelope = signed(Map.of("runId", "r-1"));
    SignedExportVerification checked = SignedExports.verify(envelope);
    assertTrue(checked.valid(), () -> checked.issues().toString());
    assertEquals(CheckedAgainst.ITS_OWN_KEY, checked.checkedAgainst());
    assertNotNull(checked.body());
    assertEquals("r-1", checked.body().get("runId"));
  }

  @Test
  void againstTrustedKeysOneVerifiesAndAStrangerIsRefused() throws Exception {
    Map<String, Object> envelope = signed(Map.of());
    String pem = (String) envelope.get("publicKey");
    String other = pem(freshKey().getPublic());

    assertTrue(SignedExports.verify(envelope, List.of(other, pem)).valid());
    SignedExportVerification refused = SignedExports.verify(envelope, List.of(other));
    assertFalse(refused.valid());
    assertEquals(CheckedAgainst.TRUSTED_KEYS, refused.checkedAgainst());
    assertTrue(String.join(" ", refused.issues()).contains("isn't one you trust"));
  }

  @Test
  void aChangedByteAndAChangedEnvelopeExportedAtFail() throws Exception {
    Map<String, Object> envelope = signed(Map.of("runId", "r-1"));

    byte[] data = Base64.getDecoder().decode((String) envelope.get("bundle"));
    String changedBody = new String(data, StandardCharsets.UTF_8).replace("r-1", "r-2");
    Map<String, Object> changed =
        with(envelope, "bundle", Base64.getEncoder().encodeToString(changedBody.getBytes(StandardCharsets.UTF_8)));
    SignedExportVerification afterChange = SignedExports.verify(changed);
    assertFalse(afterChange.valid());
    assertTrue(String.join(" ", afterChange.issues()).contains("doesn't match the bundle"));

    Map<String, Object> moved = with(envelope, "exportedAt", "2027-01-01T00:00:00.000Z");
    SignedExportVerification afterMove = SignedExports.verify(moved);
    assertFalse(afterMove.valid());
    assertTrue(String.join(" ", afterMove.issues()).contains("isn't the signed one"));
  }

  @Test
  void sharedVectorEd25519ChecksOutAndTamperedFails() throws Exception {
    assertSharedVector("ed25519");
  }

  @Test
  void sharedVectorEcdsaP256ChecksOutAndTamperedFails() throws Exception {
    assertSharedVector("ecdsa-p256-sha256");
  }

  private void assertSharedVector(String name) throws Exception {
    Map<String, Object> vector = vector(name);
    List<String> trusted = List.of((String) vector.get("publicKeyPem"));

    SignedExportVerification good = SignedExports.verify(part(vector, "valid"), trusted);
    assertTrue(good.valid(), () -> good.issues().toString());
    assertEquals(CheckedAgainst.TRUSTED_KEYS, good.checkedAgainst());
    assertNotNull(good.body());
    assertEquals("2.0.0", good.body().get("bundleSchemaVersion"));

    SignedExportVerification bad = SignedExports.verify(part(vector, "tampered"), trusted);
    assertFalse(bad.valid());
    assertTrue(String.join(" ", bad.issues()).contains("doesn't match the bundle"));
  }

  @Test
  void sharedVectorUnknownAlgorithmIsRefusedNamingIt() throws Exception {
    SignedExportVerification result = SignedExports.verify(part(vector("unknown-algorithm"), "refused"));
    assertFalse(result.valid());
    assertEquals(
        "algorithm \"ecdsa-p384-sha384\" isn't one this verifier knows "
            + "(ed25519, ecdsa-p256-sha256): a newer verifier may check it",
        result.issues().get(0));
  }

  @Test
  void exportsMadeByKindgi014VerifyAndAnOffStampReportsTheSignedTime() throws Exception {
    Map<String, Object> vector = vector("kindgi-0.1.4");
    List<String> trusted = List.of((String) vector.get("publicKeyPem"));

    SignedExportVerification same = SignedExports.verify(part(vector, "auditBundle"), trusted);
    assertTrue(same.valid(), () -> same.issues().toString());
    assertEquals(List.of(), same.notes());

    SignedExportVerification differ =
        SignedExports.verify(part(vector, "auditBundleStampsDiffer"), trusted);
    assertTrue(differ.valid(), () -> differ.issues().toString());
    assertEquals(List.of(vector.get("note")), differ.notes());

    SignedExportVerification provenance = SignedExports.verify(part(vector, "provenance"), trusted);
    assertTrue(provenance.valid(), () -> provenance.issues().toString());
    assertEquals(List.of(), provenance.notes());
  }

  @Test
  void the014LeniencyIsThatFormatAlone() throws Exception {
    Map<String, Object> ed = vector("ed25519");
    Map<String, Object> moved = with(part(ed, "valid"), "exportedAt", "2027-01-01T00:00:00.000Z");
    assertFalse(SignedExports.verify(moved).valid());

    // The integer bundleSchemaVersion alone doesn't make it a 0.1.4 bundle: the signed body must be one too.
    Map<String, Object> claimed = with(moved, "bundleSchemaVersion", 1);
    SignedExportVerification claimedResult = SignedExports.verify(claimed);
    assertFalse(claimedResult.valid());
    assertTrue(String.join(" ", claimedResult.issues()).contains("isn't the signed one"));

    Map<String, Object> old = part(vector("kindgi-0.1.4"), "auditBundleStampsDiffer");
    Map<String, Object> asBool = with(old, "bundleSchemaVersion", Boolean.TRUE);
    assertFalse(SignedExports.verify(asBool).valid());
  }

  // --- helpers ---

  private static KeyPair freshKey() throws Exception {
    return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
  }

  /** An export as the API answers one, signed with a fresh key. */
  private static Map<String, Object> signed(Map<String, Object> body) throws Exception {
    KeyPair key = freshKey();
    String exportedAt = "2026-10-08T00:00:00.000Z";
    Map<String, Object> full = new LinkedHashMap<>(body);
    full.put("bundleSchemaVersion", "1.2.0");
    full.put("exportedAt", exportedAt);
    byte[] data = KindgiJson.write(full).getBytes(StandardCharsets.UTF_8);

    Signature signer = Signature.getInstance("Ed25519");
    signer.initSign(key.getPrivate());
    signer.update(data);
    byte[] signature = signer.sign();

    Map<String, Object> envelope = new LinkedHashMap<>();
    envelope.put("kind", "provenance");
    envelope.put("runId", "r-1");
    envelope.put("bundle", Base64.getEncoder().encodeToString(data));
    envelope.put("bundleSchemaVersion", "1.2.0");
    envelope.put("algorithm", "ed25519");
    envelope.put("signingKeyId", "ex_testkey0000000");
    envelope.put("signature", Base64.getEncoder().encodeToString(signature));
    envelope.put("publicKey", pem(key.getPublic()));
    envelope.put("canonicalization", "sorted-key-json");
    envelope.put("exportedAt", exportedAt);
    return envelope;
  }

  private static String pem(PublicKey key) {
    String body = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII))
        .encodeToString(key.getEncoded());
    return "-----BEGIN PUBLIC KEY-----\n" + body + "\n-----END PUBLIC KEY-----\n";
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> vector(String name) throws Exception {
    return (Map<String, Object>)
        KindgiJson.read(Files.readString(VECTORS.resolve(name + ".json")), Map.class);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> part(Map<String, Object> vector, String key) {
    return (Map<String, Object>) vector.get(key);
  }

  private static Map<String, Object> with(Map<String, Object> envelope, String key, Object value) {
    Map<String, Object> copy = new LinkedHashMap<>(envelope);
    copy.put(key, value);
    return copy;
  }
}
