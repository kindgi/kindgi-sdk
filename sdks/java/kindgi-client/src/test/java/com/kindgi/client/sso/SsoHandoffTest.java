// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.sso;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Mirrors the TypeScript {@code sso-handoff.test.ts}: the message an admin sends whoever runs the
 * identity provider, the console steps a preset adds, and the guide link on a version's release
 * line.
 */
final class SsoHandoffTest {

  /** The guides at the docs' root: what a handoff links without a version. */
  private static final String ROOT_GUIDES = "https://docs.kindgi.com/guides/sso";

  private static final HandoffUrls OIDC =
      new HandoffUrls(
          "acme", new HandoffSignIn.Oidc("https://kindgi.acme.example/auth/sso/callback/idp-1"));
  private static final HandoffUrls SAML =
      new HandoffUrls(
          "acme-saml",
          new HandoffSignIn.Saml(
              "https://kindgi.acme.example/auth/sso/saml2/sp/acs/idp-2",
              "https://kindgi.acme.example/auth/sso/saml2/sp/metadata?providerId=idp-2",
              "https://kindgi.acme.example/auth/sso/saml2/sp/metadata?providerId=idp-2"));

  @Test
  void oidcGivesTheRedirectUriWhatToSendBackTheSecretByNameAndTheOidcGuide() {
    IdentityProviderHandoff h = SsoHandoff.forProvider(OIDC);
    assertTrue(h.message().contains("Redirect URI:  https://kindgi.acme.example/auth/sso/callback/idp-1"));
    assertTrue(h.message().contains("Send back: the issuer URL and the client ID."));
    assertTrue(h.message().contains("never by email or chat"));
    assertFalse(h.message().endsWith("\n"));
    assertTrue(h.steps().isEmpty());
    assertEquals(ROOT_GUIDES + "/oidc/", h.guideUrl());
  }

  @Test
  void samlGivesTheAcsUrlEntityIdAndMetadataUrlAndTheSamlGuide() {
    IdentityProviderHandoff h = SsoHandoff.forProvider(SAML);
    assertTrue(
        h.message()
            .contains("ACS URL (single sign-on URL):  https://kindgi.acme.example/auth/sso/saml2/sp/acs/idp-2"));
    assertTrue(
        h.message()
            .contains("Entity ID (audience):          https://kindgi.acme.example/auth/sso/saml2/sp/metadata?providerId=idp-2"));
    assertTrue(h.message().contains("Send back: the identity provider's metadata XML."));
    assertEquals(ROOT_GUIDES + "/saml/", h.guideUrl());
  }

  @Test
  void aPresetAddsItsConsoleStepsAndItsOwnGuide() {
    IdentityProviderHandoff h = SsoHandoff.forProvider(OIDC, IdentityProviderPreset.ENTRA);
    assertEquals(IdentityProviderPreset.ENTRA.steps(), h.steps().orElseThrow());
    assertTrue(h.steps().orElseThrow().contains("never `common`"));
    assertEquals(ROOT_GUIDES + "/entra-id/", h.guideUrl());
  }

  @Test
  void withAVersionTheGuideIsOnThatVersionsReleaseLine() {
    assertEquals(
        "https://docs.kindgi.com/v0.1/guides/sso/google/",
        SsoHandoff.forProvider(OIDC, IdentityProviderPreset.GOOGLE, "0.1.6").guideUrl());
    assertEquals(
        "https://docs.kindgi.com/v0.2/guides/sso/saml/",
        SsoHandoff.forProvider(SAML, null, "0.2.0-rc.1").guideUrl());
  }

  @Test
  void thePresetsAreTheNamesAPickerShowsAndAnythingElseIsNotOne() {
    assertEquals(
        List.of("Google Workspace", "Microsoft Entra ID", "Okta", "Keycloak"),
        List.of(IdentityProviderPreset.values()).stream().map(IdentityProviderPreset::label).toList());
    assertTrue(IdentityProviderPreset.fromKey("okta").isPresent());
    assertTrue(IdentityProviderPreset.fromKey("ping").isEmpty());
    assertTrue(IdentityProviderPreset.fromKey("toString").isEmpty());
  }
}
