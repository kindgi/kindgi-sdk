// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.sso;

import java.util.Objects;

/**
 * What to give the identity provider so it can send people back, as {@code GET
 * /v1/auth/providers/:id/sign-in} answers it: an {@link Oidc} redirect URI, or the {@link Saml} ACS
 * URL, entity id and metadata URL.
 */
public sealed interface HandoffSignIn permits HandoffSignIn.Oidc, HandoffSignIn.Saml {

  /** An OpenID Connect provider: the one redirect URI it sends people back to. */
  record Oidc(String redirectUri) implements HandoffSignIn {
    public Oidc {
      Objects.requireNonNull(redirectUri, "redirectUri");
    }
  }

  /** A SAML provider: the service provider's ACS URL, entity id and metadata URL. */
  record Saml(String acsUrl, String spEntityId, String spMetadataUrl) implements HandoffSignIn {
    public Saml {
      Objects.requireNonNull(acsUrl, "acsUrl");
      Objects.requireNonNull(spEntityId, "spEntityId");
      Objects.requireNonNull(spMetadataUrl, "spMetadataUrl");
    }
  }
}
