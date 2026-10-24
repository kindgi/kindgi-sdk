// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.sso;

import java.util.Objects;

/**
 * A provider's id and its sign-in URLs, as {@code GET /v1/auth/providers/:id/sign-in} answers them.
 *
 * @param providerId the provider's id, as the handoff message names it
 * @param signIn what to give the identity provider so it can send people back
 */
public record HandoffUrls(String providerId, HandoffSignIn signIn) {
  public HandoffUrls {
    Objects.requireNonNull(providerId, "providerId");
    Objects.requireNonNull(signIn, "signIn");
  }
}
