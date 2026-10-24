// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.sso;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The identity providers there are click-by-click steps for. Each carries the name a picker shows,
 * whether it's OIDC or SAML, its guide's page under {@code guides/sso/}, and the steps to take in
 * its console.
 *
 * <p>The Java counterpart of {@code IDENTITY_PROVIDER_PRESETS} in {@code @kindgi/client/sso-handoff}:
 * {@link #values()} is in the order a picker shows them, and {@link #fromKey} is {@code
 * isIdentityProviderPreset} — a key a picker sends, never an enum name.
 */
public enum IdentityProviderPreset {
  GOOGLE("google", "Google Workspace", Kind.OIDC, "google", Steps.GOOGLE),
  ENTRA("entra", "Microsoft Entra ID", Kind.OIDC, "entra-id", Steps.ENTRA),
  OKTA("okta", "Okta", Kind.OIDC, "okta", Steps.OKTA),
  KEYCLOAK("keycloak", "Keycloak", Kind.OIDC, "keycloak", Steps.KEYCLOAK);

  /** Whether a provider speaks OpenID Connect or SAML. */
  public enum Kind {
    OIDC,
    SAML
  }

  private final String key;
  private final String label;
  private final Kind kind;
  private final String guide;
  private final String steps;

  IdentityProviderPreset(String key, String label, Kind kind, String guide, String steps) {
    this.key = key;
    this.label = label;
    this.kind = kind;
    this.guide = guide;
    this.steps = steps;
  }

  /** The key a picker and the CLI use, such as {@code "entra"} (not the enum name). */
  public String key() {
    return key;
  }

  /** Its name, as a picker shows it. */
  public String label() {
    return label;
  }

  /** Whether it speaks OpenID Connect or SAML. */
  public Kind kind() {
    return kind;
  }

  /** Its guide's page, under the docs' {@code guides/sso/}. */
  public String guide() {
    return guide;
  }

  /** The steps in its console, and its issuer. */
  public String steps() {
    return steps;
  }

  private static final Map<String, IdentityProviderPreset> BY_KEY = byKey();

  private static Map<String, IdentityProviderPreset> byKey() {
    Map<String, IdentityProviderPreset> map = new LinkedHashMap<>();
    for (IdentityProviderPreset preset : values()) {
      map.put(preset.key, preset);
    }
    return Map.copyOf(map);
  }

  /** The preset a key names, such as {@code "okta"}; empty for anything that isn't one. */
  public static Optional<IdentityProviderPreset> fromKey(String key) {
    return Optional.ofNullable(BY_KEY.get(key));
  }

  /** The steps, held apart so the enum constants can name them in their constructor. */
  private static final class Steps {
    static final String GOOGLE =
        String.join(
            "\n",
            "Google Cloud console → Google Auth Platform:",
            "  1. Branding: the app name and a support email.",
            "  2. Audience: Internal (only your Google Workspace accounts; no test users, no review).",
            "  3. Data access: openid, email, profile.",
            "  4. Clients → Create client → Web application → Authorized redirect URIs: the URI above.",
            "  5. Download the client ID and secret (Google shows the secret once).",
            "Issuer: https://accounts.google.com");

    static final String ENTRA =
        String.join(
            "\n",
            "Microsoft Entra admin center → App registrations → New registration:",
            "  1. Supported account types: this organizational directory only (single tenant).",
            "  2. Redirect URI: Web, the URI above.",
            "  3. Copy the Application (client) ID and the Directory (tenant) ID.",
            "  4. Certificates & secrets → New client secret: copy its Value (shown once). It expires:",
            "     note the date.",
            "  5. Enterprise applications → the app → Properties → Assignment required: Yes; then",
            "     Users and groups: who may sign in.",
            "Issuer: https://login.microsoftonline.com/<directory-tenant-id>/v2.0 (never `common`).");

    static final String OKTA =
        String.join(
            "\n",
            "Okta admin console → Applications → Create App Integration → OIDC - OpenID Connect →",
            "Web Application:",
            "  1. Sign-in redirect URIs: the URI above.",
            "  2. Assignments: the groups who may sign in.",
            "  3. Copy the client ID and the client secret.",
            "Issuer: https://<your-org>.okta.com");

    static final String KEYCLOAK =
        String.join(
            "\n",
            "Keycloak admin console → your realm → Clients → Create client → OpenID Connect:",
            "  1. Client authentication: On. Authentication flow: Standard flow.",
            "  2. Valid redirect URIs: the URI above (exactly; no wildcard).",
            "  3. Credentials tab: copy the client secret.",
            "  4. Each person needs an email with \"Email verified\" on, or sign-in is refused.",
            "Issuer: https://<keycloak-host>/realms/<realm>");

    private Steps() {}
  }
}
