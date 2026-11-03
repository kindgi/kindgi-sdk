// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.sso;

import com.kindgi.client.DocsLinks;
import java.util.Objects;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * What an admin sends whoever runs their identity provider, to set up sign-in with Kindgi: the URLs
 * to enter (from {@code GET /v1/auth/providers/:id/sign-in}), what to send back, and, for the
 * identity providers there are steps for, the clicks in their console. The CLI ({@code kindgi sso
 * providers start}) and the console show the same text.
 *
 * <p>The Java counterpart of {@code identityProviderHandoff} in {@code @kindgi/client/sso-handoff}.
 * It builds the text from the preset table and {@link DocsLinks}, with no network and no
 * dependencies, so an app that shows its own setup screen can use it on its own.
 */
public final class SsoHandoff {

  private SsoHandoff() {}

  /** The handoff for a provider's URLs, with no console steps and the guide at the docs' root. */
  public static IdentityProviderHandoff forProvider(HandoffUrls urls) {
    return forProvider(urls, null, null);
  }

  /** The handoff with a preset's console steps and its guide at the docs' root. */
  public static IdentityProviderHandoff forProvider(HandoffUrls urls, IdentityProviderPreset preset) {
    return forProvider(urls, preset, null);
  }

  /**
   * The message for IT, the identity provider's steps (with {@code preset}) and the guide, for a
   * provider's URLs.
   *
   * @param urls the provider's id and sign-in URLs
   * @param preset the identity provider to add console steps for, or {@code null} for none
   * @param version the Kindgi version whose docs the guide link names (the CLI's, or the runtime's
   *     in a console); {@code null} links the docs' root, which moves on to the next release line
   */
  public static IdentityProviderHandoff forProvider(
      HandoffUrls urls, @Nullable IdentityProviderPreset preset, @Nullable String version) {
    Objects.requireNonNull(urls, "urls");
    HandoffSignIn signIn = urls.signIn();

    String message;
    String fallbackGuide;
    if (signIn instanceof HandoffSignIn.Oidc oidc) {
      message = oidcMessage(urls.providerId(), oidc);
      fallbackGuide = "oidc";
    } else {
      HandoffSignIn.Saml saml = (HandoffSignIn.Saml) signIn;
      message = samlMessage(urls.providerId(), saml);
      fallbackGuide = "saml";
    }

    Optional<String> steps = preset == null ? Optional.empty() : Optional.of(preset.steps());
    String guide = preset == null ? fallbackGuide : preset.guide();
    String guideUrl = DocsLinks.docsUrl("guides/sso/" + guide + "/", version);
    return new IdentityProviderHandoff(message, steps, guideUrl);
  }

  private static String oidcMessage(String providerId, HandoffSignIn.Oidc oidc) {
    return String.join(
        "\n",
        "Sign-in with \"" + providerId + "\" (OpenID Connect). Send this to whoever runs your identity provider:",
        "",
        "  Create an OpenID Connect web application (a confidential client) for Kindgi.",
        "  Redirect URI:  " + oidc.redirectUri(),
        "  Scopes:        openid email profile",
        "  Let in only the people who should use Kindgi (assign users or groups).",
        "",
        "  Send back: the issuer URL and the client ID. The client secret goes into",
        "  Kindgi's secret store under a name, never by email or chat:",
        "    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant");
  }

  private static String samlMessage(String providerId, HandoffSignIn.Saml saml) {
    return String.join(
        "\n",
        "Sign-in with \"" + providerId + "\" (SAML). Send this to whoever runs your identity provider:",
        "",
        "  Create a SAML 2.0 application for Kindgi.",
        "  ACS URL (single sign-on URL):  " + saml.acsUrl(),
        "  Entity ID (audience):          " + saml.spEntityId(),
        "  Service provider metadata:     " + saml.spMetadataUrl(),
        "  Name ID: the email address (or an `email` attribute). Sign the assertions.",
        "  Let in only the people who should use Kindgi (assign users or groups).",
        "",
        "  Send back: the identity provider's metadata XML.");
  }
}
