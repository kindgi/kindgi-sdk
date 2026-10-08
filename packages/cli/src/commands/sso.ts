// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';

import type {
  IdentityProviderRegisterInput,
  IdentityProviderSignInUrlsResult,
  IdentityProviderUpdateInput,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { type Rendered, renderJson } from '../output.js';
import {
  listFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi sso providers`: set up sign-in with an organization's identity
 * provider the way it happens in practice. The admin starts here and gets
 * the URLs to give IT (`start`); IT creates the app on their side and sends
 * back what it gave them; the admin registers it (`finish`), changes it
 * later without the URLs moving (`update`), and tries it (`test`).
 */

type Kind = 'oidc' | 'saml';

/** The identity providers `start --idp` has steps for. */
/** The setup guides, at the docs' root (always the latest release). */
const GUIDES = 'https://docs.kindgi.com/guides/sso';

const IDP_STEPS: Readonly<
  Record<string, { readonly kind: Kind; readonly guide: string; readonly steps: string }>
> = {
  google: {
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

const kindOption = {
  kind: {
    type: 'string' as const,
    description: '`oidc` (OpenID Connect: Google, Entra ID, Okta, Keycloak…) or `saml`.',
  },
};

/** The provider's fields as flags; `--spec` takes anything else, as JSON. */
const configOptions = {
  ...kindOption,
  name: {
    type: 'string' as const,
    description: 'What the sign-in button says ("Sign in with …").',
  },
  domains: {
    type: 'string' as const,
    multiple: true,
    description:
      'An email domain whose people sign in with it (`acme.com`); repeatable or comma-separated.',
  },
  issuer: { type: 'string' as const, description: 'OIDC: the issuer URL.' },
  'client-id': { type: 'string' as const, description: 'OIDC: the client ID.' },
  'client-secret-ref': {
    type: 'string' as const,
    description:
      "OIDC: the NAME of the client secret in Kindgi's secret store (`kindgi secrets set <NAME>`), never the secret.",
  },
  'idp-metadata': {
    type: 'string' as const,
    description: "SAML: the identity provider's metadata XML, as `@<file>`.",
  },
  'sp-signing-key-ref': {
    type: 'string' as const,
    description:
      'SAML: the NAME of the signing key, for identity providers that want signed requests.',
  },
  spec: {
    type: 'string' as const,
    description: 'Any other provider fields, as inline JSON or `@<file>` (flags win).',
  },
};

async function configFromFlags(ctx: CommandContext): Promise<Record<string, unknown>> {
  const specText = stringFlag(ctx, 'spec');
  const spec = specText === undefined ? {} : await readJsonInput(specText);
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('--spec must be a JSON object');
  }
  const domains = listFlag(ctx, 'domains')
    .flatMap((d) => d.split(','))
    .map((d) => d.trim())
    .filter((d) => d !== '');
  const metadataArg = stringFlag(ctx, 'idp-metadata');
  if (metadataArg !== undefined && !metadataArg.startsWith('@')) {
    throw new Error('--idp-metadata takes a file: --idp-metadata=@<path-to-metadata.xml>');
  }
  const flags: Record<string, unknown> = {
    kind: stringFlag(ctx, 'kind'),
    displayName: stringFlag(ctx, 'name'),
    issuer: stringFlag(ctx, 'issuer'),
    clientId: stringFlag(ctx, 'client-id'),
    clientSecretRef: stringFlag(ctx, 'client-secret-ref'),
    spSigningKeyRef: stringFlag(ctx, 'sp-signing-key-ref'),
    ...(domains.length > 0 && { domains }),
    ...(metadataArg !== undefined && {
      idpMetadataXml: await readFile(metadataArg.slice(1), 'utf8'),
    }),
  };
  for (const [k, v] of Object.entries(flags)) if (v === undefined) delete flags[k];
  return { ...(spec as Record<string, unknown>), ...flags };
}

function kindFlag(ctx: CommandContext): Kind | undefined {
  const kind = stringFlag(ctx, 'kind');
  if (kind === undefined || kind === 'oidc' || kind === 'saml') return kind;
  throw new Error('--kind must be `oidc` or `saml`');
}

/** What to send IT: the URLs for their side, and what to send back. */
export function handoffText(urls: IdentityProviderSignInUrlsResult, idp?: string): string {
  const { providerId, signIn } = urls;
  const out: string[] = [];
  if ('redirectUri' in signIn) {
    out.push(
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
    );
  } else {
    out.push(
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
    );
  }
  const steps = idp === undefined ? undefined : IDP_STEPS[idp];
  if (steps !== undefined) out.push('', steps.steps);
  const guide = steps?.guide ?? ('redirectUri' in signIn ? 'oidc' : 'saml');
  out.push('', `Step by step: ${GUIDES}/${guide}/`);
  out.push(
    '',
    'Then register it:',
    'redirectUri' in signIn
      ? `  kindgi sso providers finish ${providerId} --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>`
      : `  kindgi sso providers finish ${providerId} --kind=saml --idp-metadata=@<metadata.xml> --domains=<your-domain>`,
    '',
    'These URLs stay the same after registering and after any `update`.',
  );
  return `${out.join('\n')}\n`;
}

const start: LeafCommand = {
  kind: 'leaf',
  name: 'start',
  description:
    'Get the URLs to give your identity provider, before registering anything, and a message to send IT.',
  usage:
    'kindgi sso providers start <provider-id> --kind=oidc|saml [--idp=google|entra|okta|keycloak]',
  optionSpec: {
    ...kindOption,
    idp: {
      type: 'string' as const,
      description:
        'Add the click-by-click steps for `google`, `entra`, `okta` or `keycloak` (OIDC).',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'sso providers start', async (): Promise<Rendered> => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      const idp = stringFlag(ctx, 'idp');
      if (idp !== undefined && IDP_STEPS[idp] === undefined) {
        throw new Error(`--idp must be one of: ${Object.keys(IDP_STEPS).join(', ')}`);
      }
      const kind = kindFlag(ctx) ?? (idp !== undefined ? IDP_STEPS[idp]?.kind : undefined);
      const urls = await ctx
        .client()
        .auth.providers.signIn(providerId, kind === undefined ? undefined : { kind });
      if (ctx.globals.formatRequested) return renderJson(urls, ctx.globals.format);
      return { stdout: handoffText(urls, idp), stderr: '' };
    }),
};

const finish: LeafCommand = {
  kind: 'leaf',
  name: 'finish',
  description: 'Register the provider with what your identity provider gave back.',
  usage:
    'kindgi sso providers finish <provider-id> --domains=<d> (--kind=oidc --issuer=<url> --client-id=<id> --client-secret-ref=<NAME> | --kind=saml --idp-metadata=@<file>) [--name=<text>] [...]',
  optionSpec: configOptions,
  run: (ctx) =>
    runSdk(ctx, 'sso providers finish', async () => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      kindFlag(ctx);
      const config: Record<string, unknown> = { ...(await configFromFlags(ctx)), providerId };
      if (config.kind === undefined) throw new Error('--kind=oidc|saml is required');
      if (!Array.isArray(config.domains) || config.domains.length === 0) {
        throw new Error(
          "--domains=<your-domain> is required: sign-in is email first, so people find this provider by their email's domain",
        );
      }
      return await ctx.client().auth.providers.register(config as IdentityProviderRegisterInput);
    }),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description: "Change a provider; its URLs (on your identity provider's side) don't change.",
  usage:
    'kindgi sso providers update <provider-id> [--client-id=<id>] [--client-secret-ref=<NAME>] [--domains=<d>] [--name=<text>] [--remove=<field>] [...]',
  optionSpec: {
    ...configOptions,
    remove: {
      type: 'string' as const,
      multiple: true,
      description: 'An optional field to remove (e.g. `displayName`, `domains`); repeatable.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'sso providers update', async () => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      kindFlag(ctx);
      const changes: Record<string, unknown> = await configFromFlags(ctx);
      for (const field of listFlag(ctx, 'remove').flatMap((f) => f.split(','))) {
        if (field.trim() !== '') changes[field.trim()] = null;
      }
      if (Object.keys(changes).length === 0)
        throw new Error('Nothing to change: give a flag or --spec');
      return await ctx
        .client()
        .auth.providers.update(providerId, changes as IdentityProviderUpdateInput);
    }),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Show one provider, with the URLs your identity provider has.',
  usage: 'kindgi sso providers get <provider-id>',
  run: (ctx) =>
    runSdk(ctx, 'sso providers get', async () => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      return await ctx.client().auth.providers.get(providerId);
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List this tenant's sign-in providers.",
  usage: 'kindgi sso providers list',
  run: (ctx) =>
    runSdk(ctx, 'sso providers list', async () => await ctx.client().auth.providers.list(), {
      rows: (page) => page.data,
      columns: [
        { header: 'PROVIDER', get: (p) => p.providerId },
        { header: 'KIND', get: (p) => p.kind },
        { header: 'NAME', get: (p) => p.displayName ?? '' },
        { header: 'DOMAINS', get: (p) => (p.domains ?? []).join(',') },
      ],
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description:
    "Stop signing in with a provider. Registering the same id again gives it the same URLs, but nobody's earlier sign-in carries over.",
  usage: 'kindgi sso providers remove <provider-id>',
  run: (ctx) =>
    runSdk(ctx, 'sso providers remove', async () => {
      const providerId = requiredPositional(ctx, 0, 'provider-id');
      return await ctx.client().auth.providers.unregister(providerId);
    }),
};

const test: LeafCommand = {
  kind: 'leaf',
  name: 'test',
  description: 'The link to try signing in with a provider, as a person at one of its domains.',
  usage: 'kindgi sso providers test <provider-id> [--email=<someone@your-domain>]',
  optionSpec: {
    email: {
      type: 'string' as const,
      description: "Whose sign-in to try; default: someone at the provider's first domain.",
    },
  },
  run: (ctx) =>
    runSdkRendered(
      ctx,
      'sso providers test',
      async (): Promise<Rendered & { exitCode?: number }> => {
        const providerId = requiredPositional(ctx, 0, 'provider-id');
        const client = ctx.client();
        const provider = await client.auth.providers.get(providerId);
        const domain = provider.domains?.[0];
        const email =
          stringFlag(ctx, 'email') ?? (domain === undefined ? undefined : `someone@${domain}`);
        const options = await client.auth.signInOptions(
          email === undefined ? undefined : { email },
        );
        const option = options.data.find((o) => o.providerId === providerId);
        const signInUrl =
          option === undefined ? undefined : new URL(option.signInUrl, ctx.apiUrl()).toString();
        if (ctx.globals.formatRequested) {
          return renderJson(
            { providerId, email, signInUrl: signInUrl ?? null },
            ctx.globals.format,
          );
        }
        if (signInUrl !== undefined) {
          return {
            stdout: [
              `Open this in a browser and sign in as a person who's been added to this tenant:`,
              `  ${signInUrl}`,
              '',
              'Afterwards, the console shows who you are signed in as.',
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        const why =
          email === undefined
            ? `"${providerId}" has no domains. Sign-in is email first, so people find a provider by their email's domain: kindgi sso providers update ${providerId} --domains=<your-domain>`
            : `No sign-in page offers "${providerId}" for ${email}: its domain isn't one of the provider's, or another tenant claims it too.`;
        return { stdout: '', stderr: `${why}\n`, exitCode: 1 };
      },
    ),
};

const providers: Command = {
  kind: 'group',
  name: 'providers',
  description: "Your organization's identity providers (Google, Entra ID, Okta, Keycloak, SAML…).",
  subcommands: [start, finish, update, get, list, test, remove],
};

export const ssoCommand: Command = {
  kind: 'group',
  name: 'sso',
  description: "Sign-in with your organization's identity provider (single sign-on).",
  subcommands: [providers],
};
