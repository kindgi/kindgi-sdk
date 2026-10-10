// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/client/sso-handoff`: what an admin sends whoever runs their
 * identity provider, to set up sign-in with Kindgi. The URLs to enter (from
 * `GET /v1/auth/providers/:id/sign-in`), what to send back, and, for the
 * identity providers we have steps for, the clicks in their console. The
 * CLI (`kindgi sso providers start`) and the console show the same text.
 * No dependencies, so a browser app can import it without the client.
 */

import { docsUrl } from './docs-links.js';

export { docsUrl };

/** What to give the identity provider so it can send people back. */
export type HandoffSignIn =
  | { readonly redirectUri: string }
  | { readonly acsUrl: string; readonly spEntityId: string; readonly spMetadataUrl: string };

/** The provider's id and its URLs, as `GET /v1/auth/providers/:id/sign-in` answers them. */
export interface HandoffUrls {
  readonly providerId: string;
  readonly signIn: HandoffSignIn;
}

/** The identity providers there are click-by-click steps for. */
export type IdentityProviderPreset = 'google' | 'entra' | 'okta' | 'keycloak';

export interface IdentityProviderPresetInfo {
  /** Its name, as a picker shows it. */
  readonly label: string;
  readonly kind: 'oidc' | 'saml';
  /** Its guide's page, under the docs' `guides/sso/`. */
  readonly guide: string;
  /** The steps in its console, and its issuer. */
  readonly steps: string;
}

export const IDENTITY_PROVIDER_PRESETS: Readonly<
  Record<IdentityProviderPreset, IdentityProviderPresetInfo>
> = {
  google: {
    label: 'Google Workspace',
    kind: 'oidc',
    guide: 'google',
    steps: [
      'Google Cloud console → Google Auth Platform:',
      '  1. Branding: the app name and a support email.',
      '  2. Audience: Internal (only your Google Workspace accounts; no test users, no review).',
      '  3. Data access: openid, email, profile.',
      '  4. Clients → Create client → Web application → Authorized redirect URIs: the URI above.',
      '  5. Download the client ID and secret (Google shows the secret once).',
      'Issuer: https://accounts.google.com',
    ].join('\n'),
  },
  entra: {
    label: 'Microsoft Entra ID',
    kind: 'oidc',
    guide: 'entra-id',
    steps: [
      'Microsoft Entra admin center → App registrations → New registration:',
      '  1. Supported account types: this organizational directory only (single tenant).',
      '  2. Redirect URI: Web, the URI above.',
      '  3. Copy the Application (client) ID and the Directory (tenant) ID.',
      '  4. Certificates & secrets → New client secret: copy its Value (shown once). It expires:',
      '     note the date.',
      '  5. Enterprise applications → the app → Properties → Assignment required: Yes; then',
      '     Users and groups: who may sign in.',
      'Issuer: https://login.microsoftonline.com/<directory-tenant-id>/v2.0 (never `common`).',
    ].join('\n'),
  },
  okta: {
    label: 'Okta',
    kind: 'oidc',
    guide: 'okta',
    steps: [
      'Okta admin console → Applications → Create App Integration → OIDC - OpenID Connect →',
      'Web Application:',
      '  1. Sign-in redirect URIs: the URI above.',
      '  2. Assignments: the groups who may sign in.',
      '  3. Copy the client ID and the client secret.',
      'Issuer: https://<your-org>.okta.com',
    ].join('\n'),
  },
  keycloak: {
    label: 'Keycloak',
    kind: 'oidc',
    guide: 'keycloak',
    steps: [
      'Keycloak admin console → your realm → Clients → Create client → OpenID Connect:',
      '  1. Client authentication: On. Authentication flow: Standard flow.',
      '  2. Valid redirect URIs: the URI above (exactly; no wildcard).',
      '  3. Credentials tab: copy the client secret.',
      '  4. Each person needs an email with "Email verified" on, or sign-in is refused.',
      'Issuer: https://<keycloak-host>/realms/<realm>',
    ].join('\n'),
  },
};

export function isIdentityProviderPreset(value: string): value is IdentityProviderPreset {
  return Object.hasOwn(IDENTITY_PROVIDER_PRESETS, value);
}

export interface IdentityProviderHandoff {
  /** The message for whoever runs the identity provider: the URLs and what to send back. */
  readonly message: string;
  /** The steps in that identity provider's console, when there are some. */
  readonly steps?: string;
  /** The step-by-step guide, on the release line of `options.version` ({@link docsUrl}). */
  readonly guideUrl: string;
}

/**
 * The message for IT, the identity provider's steps (with `preset`) and
 * the guide, for a provider's URLs. Lines are joined with `\n`, with no
 * trailing newline. `options.version`: the Kindgi version whose docs the
 * guide link names (the CLI's, or the runtime's in a console); without it,
 * the docs' root, which moves on to the next release line.
 */
export function identityProviderHandoff(
  urls: HandoffUrls,
  preset?: IdentityProviderPreset,
  options: { readonly version?: string } = {},
): IdentityProviderHandoff {
  const { providerId, signIn } = urls;
  const message =
    'redirectUri' in signIn
      ? [
          `Sign-in with "${providerId}" (OpenID Connect). Send this to whoever runs your identity provider:`,
          '',
          '  Create an OpenID Connect web application (a confidential client) for Kindgi.',
          `  Redirect URI:  ${signIn.redirectUri}`,
          '  Scopes:        openid email profile',
          '  Let in only the people who should use Kindgi (assign users or groups).',
          '',
          '  Send back: the issuer URL and the client ID. The client secret goes into',
          "  Kindgi's secret store under a name, never by email or chat:",
          '    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant',
        ]
      : [
          `Sign-in with "${providerId}" (SAML). Send this to whoever runs your identity provider:`,
          '',
          '  Create a SAML 2.0 application for Kindgi.',
          `  ACS URL (single sign-on URL):  ${signIn.acsUrl}`,
          `  Entity ID (audience):          ${signIn.spEntityId}`,
          `  Service provider metadata:     ${signIn.spMetadataUrl}`,
          '  Name ID: the email address (or an `email` attribute). Sign the assertions.',
          '  Let in only the people who should use Kindgi (assign users or groups).',
          '',
          "  Send back: the identity provider's metadata XML.",
        ];
  const info = preset === undefined ? undefined : IDENTITY_PROVIDER_PRESETS[preset];
  const guide = info?.guide ?? ('redirectUri' in signIn ? 'oidc' : 'saml');
  return {
    message: message.join('\n'),
    ...(info !== undefined && { steps: info.steps }),
    guideUrl: docsUrl(`guides/sso/${guide}/`, options.version),
  };
}
