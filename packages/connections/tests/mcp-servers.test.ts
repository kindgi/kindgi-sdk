// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { type AppEntry, defineApp } from '../src/index.js';

/** An app whose own MCP server its connections sign in to, as HubSpot's and Asana's do. */
const acme: AppEntry = {
  id: 'acme',
  name: 'Acme',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://mcp.acme.example/authorize',
    tokenUrl: 'https://mcp.acme.example/token',
    pkce: 'S256',
    scopesFrom: 'registration',
  },
  owners: ['member', 'company'],
  permissions: { 'mcp.tools': { grants: 'mcp.tools', says: "Use Acme's tools", changes: true } },
  account: { kind: 'none' },
  removal: {},
  setupGuide: '/guides/connections/acme/',
  mcpServers: [
    {
      origin: 'https://mcp.acme.example',
      resource: 'https://mcp.acme.example/v2',
      issuer: 'https://mcp.acme.example',
    },
  ],
};

function withAcme(patch: Record<string, unknown>): AppEntry {
  return { ...acme, ...patch } as AppEntry;
}

function withSignIn(patch: Record<string, unknown>): AppEntry {
  return { ...acme, signIn: { ...acme.signIn, ...patch } } as AppEntry;
}

function withServer(patch: Record<string, unknown>): AppEntry {
  return { ...acme, mcpServers: [{ ...acme.mcpServers?.[0], ...patch }] } as AppEntry;
}

describe('defineApp: MCP servers, scopes set by the registration, and no account lookup', () => {
  it('takes the entry, frozen, with its server kept exactly as written', () => {
    const entry = defineApp(acme);
    expect(entry).toEqual(acme);
    expect(Object.isFrozen(entry.mcpServers?.[0])).toBe(true);
  });

  it('takes the sign-in default for scopes, an issuer on another origin, and two servers', () => {
    expect(() =>
      defineApp(
        withAcme({
          signIn: { ...acme.signIn, scopesFrom: 'sign-in', scopes: ['offline_access'] },
          permissions: { 'mcp.tools': { grants: 'mcp:all', says: 'Use the tools', changes: true } },
          mcpServers: [
            {
              origin: 'https://mcp.acme.example',
              resource: 'https://mcp.acme.example',
              issuer: 'https://login.acme.example/oauth',
            },
            {
              origin: 'https://mcp.eu.acme.example',
              resource: 'https://mcp.eu.acme.example/mcp',
              issuer: 'https://login.acme.example/oauth',
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('takes no account lookup with scopes asked at the sign-in, and no MCP server', () => {
    const { mcpServers: _none, signIn, ...entry } = acme;
    if (signIn.kind !== 'oauth2') throw new Error('acme signs in with oauth2');
    const { scopesFrom: _default, ...oauth2 } = signIn;
    expect(() =>
      defineApp({
        ...entry,
        signIn: oauth2,
        permissions: { 'notes.read': { grants: 'notes:read', says: 'Read', changes: false } },
      }),
    ).not.toThrow();
  });

  it.each([
    [
      'a scopesFrom outside the set',
      withSignIn({ scopesFrom: 'app' }),
      /signIn.scopesFrom must be "sign-in" or "registration"/,
    ],
    [
      'a scopesFrom on a GitHub App',
      withAcme({
        signIn: { kind: 'github-app', scopesFrom: 'registration' },
        account: { kind: 'github-installation' },
        mcpServers: undefined,
      }),
      /signIn.scopesFrom is for an "oauth2" sign-in/,
    ],
    [
      "a permission that doesn't grant its own key, with scopes the registration sets",
      withAcme({
        permissions: { 'mcp.tools': { grants: 'crm.read', says: 'Read', changes: false } },
      }),
      /permissions\["mcp.tools"\].grants must be "mcp.tools"/,
    ],
    [
      'sign-in scopes, with scopes the registration sets',
      withSignIn({ scopes: ['offline_access'] }),
      /signIn.scopes can't be given/,
    ],
    [
      'a scope resource, with scopes the registration sets',
      withSignIn({ scopeResource: 'https://api.acme.example/' }),
      /signIn.scopeResource can't be given/,
    ],
    [
      'an OpenID lookup, with scopes the registration sets',
      withAcme({
        account: { kind: 'openid', issuers: ['https://mcp.acme.example'], scopes: ['openid'] },
      }),
      /account.kind "openid".* can't be given/,
    ],
    [
      "a profile lookup's scopes, with scopes the registration sets",
      withAcme({
        account: {
          kind: 'profile',
          url: 'https://mcp.acme.example/me',
          scopes: ['profile'],
          id: 'id',
          label: ['name'],
        },
      }),
      /account.scopes can't be given/,
    ],
    [
      'no account lookup on a token sign-in',
      withAcme({
        signIn: { kind: 'token', providers: ['telnyx'] },
        mcpServers: undefined,
      }),
      /a "token" sign-in needs account.kind "number"/,
    ],
    [
      'no account lookup on a GitHub App',
      withAcme({ signIn: { kind: 'github-app' }, mcpServers: undefined }),
      /account.kind "none" needs an "oauth2" sign-in/,
    ],
    [
      'MCP servers on a GitHub App',
      withAcme({ signIn: { kind: 'github-app' }, account: { kind: 'github-installation' } }),
      /mcpServers needs an "oauth2" sign-in/,
    ],
    [
      'an empty list of MCP servers',
      withAcme({ mcpServers: [] }),
      /mcpServers must list at least one server/,
    ],
    [
      'an origin twice',
      withAcme({ mcpServers: [acme.mcpServers?.[0], acme.mcpServers?.[0]] }),
      /mcpServers lists https:\/\/mcp.acme.example twice/,
    ],
    [
      'an http origin',
      withServer({ origin: 'http://mcp.acme.example' }),
      /mcpServers\[0\].origin must be an https URL/,
    ],
    [
      'an origin with a path',
      withServer({ origin: 'https://mcp.acme.example/mcp' }),
      /origin must be an https origin only/,
    ],
    [
      'an origin with a trailing slash',
      withServer({ origin: 'https://mcp.acme.example/' }),
      /origin must be an https origin only/,
    ],
    [
      'an origin with its default port',
      withServer({ origin: 'https://mcp.acme.example:443' }),
      /origin must be an https origin only/,
    ],
    [
      'a resource on another origin',
      withServer({ resource: 'https://api.acme.example/v2' }),
      /mcpServers\[0\].resource must be on https:\/\/mcp.acme.example/,
    ],
    [
      'a resource with a query',
      withServer({ resource: 'https://mcp.acme.example/v2?x=1' }),
      /resource can't have a query, a fragment or a user/,
    ],
    [
      'a resource with an empty fragment',
      withServer({ resource: 'https://mcp.acme.example/v2#' }),
      /resource can't have a query, a fragment or a user/,
    ],
    [
      'a resource with a user',
      withServer({ resource: 'https://ana@mcp.acme.example/v2' }),
      /resource can't have a query, a fragment or a user/,
    ],
    [
      'an issuer that is no URL',
      withServer({ issuer: 'acme' }),
      /mcpServers\[0\].issuer must be an https URL/,
    ],
    [
      'an issuer with a query',
      withServer({ issuer: 'https://mcp.acme.example/?tenant=1' }),
      /issuer can't have a query or a fragment/,
    ],
    [
      'a server that is no object',
      withAcme({ mcpServers: ['https://mcp.acme.example'] }),
      /mcpServers\[0\] must be an object/,
    ],
  ])('refuses %s, naming the field', (_what, entry, message) => {
    expect(() => defineApp(entry)).toThrow(TypeError);
    expect(() => defineApp(entry)).toThrow(message);
  });
});
