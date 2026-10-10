// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/client/sso-handoff`: the message an admin sends whoever runs the
 * identity provider. The CLI's `kindgi sso providers start` output is its
 * byte-for-byte check (snapshots in packages/cli); these pin the parts a
 * console composes on its own, and that the built entry stands alone.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  IDENTITY_PROVIDER_PRESETS,
  SSO_GUIDES,
  identityProviderHandoff,
  isIdentityProviderPreset,
} from '../src/sso-handoff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OIDC = {
  providerId: 'acme',
  signIn: { redirectUri: 'https://kindgi.acme.example/auth/sso/callback/idp-1' },
};
const SAML = {
  providerId: 'acme-saml',
  signIn: {
    acsUrl: 'https://kindgi.acme.example/auth/sso/saml2/sp/acs/idp-2',
    spEntityId: 'https://kindgi.acme.example/auth/sso/saml2/sp/metadata?providerId=idp-2',
    spMetadataUrl: 'https://kindgi.acme.example/auth/sso/saml2/sp/metadata?providerId=idp-2',
  },
};

describe('identityProviderHandoff', () => {
  test('OIDC: the redirect URI, what to send back, the secret by name; the OIDC guide', () => {
    const h = identityProviderHandoff(OIDC);
    expect(h.message).toContain(`Redirect URI:  ${OIDC.signIn.redirectUri}`);
    expect(h.message).toContain('Send back: the issuer URL and the client ID.');
    expect(h.message).toContain('never by email or chat');
    expect(h.message.endsWith('\n')).toBe(false);
    expect(h.steps).toBeUndefined();
    expect(h.guideUrl).toBe(`${SSO_GUIDES}/oidc/`);
  });

  test('SAML: the ACS URL, entity ID and metadata URL; the SAML guide', () => {
    const h = identityProviderHandoff(SAML);
    expect(h.message).toContain(`ACS URL (single sign-on URL):  ${SAML.signIn.acsUrl}`);
    expect(h.message).toContain(`Entity ID (audience):          ${SAML.signIn.spEntityId}`);
    expect(h.message).toContain("Send back: the identity provider's metadata XML.");
    expect(h.guideUrl).toBe(`${SSO_GUIDES}/saml/`);
  });

  test("a preset adds its console's steps and its own guide", () => {
    const h = identityProviderHandoff(OIDC, 'entra');
    expect(h.steps).toBe(IDENTITY_PROVIDER_PRESETS.entra.steps);
    expect(h.steps).toContain('never `common`');
    expect(h.guideUrl).toBe(`${SSO_GUIDES}/entra-id/`);
  });

  test('the presets: names a picker shows; anything else is not one', () => {
    expect(Object.values(IDENTITY_PROVIDER_PRESETS).map((p) => p.label)).toEqual([
      'Google Workspace',
      'Microsoft Entra ID',
      'Okta',
      'Keycloak',
    ]);
    expect(isIdentityProviderPreset('okta')).toBe(true);
    expect(isIdentityProviderPreset('ping')).toBe(false);
    expect(isIdentityProviderPreset('toString')).toBe(false);
  });

  test('the built entry imports nothing, so a browser app can take it alone', async () => {
    const built = await readFile(join(__dirname, '..', 'dist', 'sso-handoff.js'), 'utf8');
    expect(built).not.toMatch(/^\s*import\s|\bfrom\s+['"]|require\(/m);
  });
});
