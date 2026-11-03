// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.exports;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * What {@link SignedExports#verify} found checking a signed export.
 *
 * <p>The Java counterpart of {@code SignedExportVerification} in the TypeScript and Python clients:
 * nothing is thrown for an export that doesn't verify — {@link #valid()} is {@code false} and {@link
 * #issues()} says why, each in words.
 *
 * @param valid the signature checks out (and, when trusted keys were given, the key is one of them)
 * @param signingKeyId the export's {@code signingKeyId}, or {@code ""} when it has none
 * @param checkedAgainst whether the signing key was checked against trusted keys or only the
 *     export's own
 * @param issues what failed, in words; empty when {@link #valid()}
 * @param body the signed body, parsed; present only when the signature checks out
 * @param notes what a valid export's reader should know (for a Kindgi 0.1.4 audit bundle whose
 *     envelope {@code exportedAt} isn't the signed one, the signed time); empty otherwise
 */
public record SignedExportVerification(
    boolean valid,
    String signingKeyId,
    CheckedAgainst checkedAgainst,
    List<String> issues,
    @Nullable Map<String, Object> body,
    List<String> notes) {

  /** Which keys {@link SignedExports#verify} checked the signing key against. */
  public enum CheckedAgainst {
    /**
     * The caller's trusted keys (the {@code publicKeyPem} values from {@code GET
     * /v1/export-signing-keys}, or a pinned key).
     */
    TRUSTED_KEYS("trusted-keys"),
    /**
     * Only the export's own {@code publicKey}: it proves the bytes weren't changed, not who signed
     * them.
     */
    ITS_OWN_KEY("its-own-key");

    private final String wire;

    CheckedAgainst(String wire) {
      this.wire = wire;
    }

    /** The wire string, the same literal the TypeScript and Python clients use. */
    public String wireValue() {
      return wire;
    }

    @Override
    public String toString() {
      return wire;
    }
  }
}
