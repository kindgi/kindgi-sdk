// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi sign-in join-domains`: the email domains people may join the workspace from. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const ACME = {
  domain: 'acme.example',
  role: 'viewer',
  createdAt: '2026-11-01T09:00:00.000Z',
  createdBy: 'user:u-ada',
};
const GLOBEX = {
  domain: 'xn--bcher-kva.example',
  role: 'none',
  createdAt: '2026-11-02T09:00:00.000Z',
  createdBy: 'service_account:sa-ops',
  updatedAt: '2026-11-03T09:00:00.000Z',
  updatedBy: 'user:u-ada',
};

const refused = (code: string, message: string, status: number) =>
  new KindgiApiError(fromWire({ code, message }, status));

interface Answers {
  readonly allow?: (input: { domain: string; role?: string }) => Promise<unknown>;
  readonly unregister?: (domain: string) => Promise<unknown>;
}

async function run(argv: readonly string[], answers: Answers = {}) {
  const calls: unknown[][] = [];
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        auth: {
          joinDomains: {
            list: async (...args: unknown[]) => {
              calls.push(['list', ...args]);
              return { data: [ACME, GLOBEX], hasMore: false };
            },
            allow: async (input: { domain: string; role?: string }) => {
              calls.push(['allow', input]);
              if (answers.allow !== undefined) return await answers.allow(input);
              return { ...ACME, domain: input.domain, role: input.role ?? 'viewer' };
            },
            unregister: async (domain: string) => {
              calls.push(['unregister', domain]);
              if (answers.unregister !== undefined) return await answers.unregister(domain);
              return { domain, unregistered: true };
            },
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi sign-in join-domains list', () => {
  test('the domains as the API has them', async () => {
    const { out, calls } = await run(['sign-in', 'join-domains', 'list']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list']]);
    expect(JSON.parse(out.stdout)).toEqual({ data: [ACME, GLOBEX], hasMore: false });
  });

  test('as a table: the domain, what a joiner gets, when and by whom it was allowed', async () => {
    const { out } = await run(['sign-in', 'join-domains', 'list', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    const [header, rule, ...rows] = out.stdout.trimEnd().split('\n');
    expect(header?.split(/\s+/)).toEqual(['DOMAIN', 'ROLE', 'ALLOWED', 'BY']);
    expect(rule).toMatch(/^[─ ]+$/);
    expect(rows.map((r) => r.split(/\s+/))).toEqual([
      ['acme.example', 'viewer', '2026-11-01T09:00:00.000Z', 'user:u-ada'],
      ['xn--bcher-kva.example', 'none', '2026-11-02T09:00:00.000Z', 'service_account:sa-ops'],
    ]);
  });
});

describe('kindgi sign-in join-domains allow', () => {
  test('sends the domain as given and no role, so the API gives its default; says what a joiner gets', async () => {
    const { out, calls } = await run(['sign-in', 'join-domains', 'allow', '@Acme.Example']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['allow', { domain: '@Acme.Example' }]]);
    expect(JSON.parse(out.stdout).role).toBe('viewer');
    expect(out.stderr).toBe(
      'People at @Acme.Example may join, as viewer on the default project.\n',
    );
  });

  test.each([
    ['runner', 'as runner on the default project'],
    ['none', 'with no project role'],
  ] as const)('--role=%s', async (role, words) => {
    const { out, calls } = await run([
      'sign-in',
      'join-domains',
      'allow',
      'acme.example',
      `--role=${role}`,
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['allow', { domain: 'acme.example', role }]]);
    expect(out.stderr).toBe(`People at acme.example may join, ${words}.\n`);
  });

  test('--role takes viewer, runner or none only; a domain is required', async () => {
    const admin = await run(['sign-in', 'join-domains', 'allow', 'acme.example', '--role=admin']);
    expect(admin.out.exitCode).not.toBe(0);
    expect(admin.out.stderr).toContain('--role takes viewer, runner, none (got admin)');
    expect(admin.calls).toEqual([]);
    const none = await run(['sign-in', 'join-domains', 'allow']);
    expect(none.out.exitCode).not.toBe(0);
    expect(none.out.stderr).toContain('Missing required argument: domain');
    expect(none.calls).toEqual([]);
  });

  test("a key that isn't the operator's: the API's refusal, then how to allow from the CLI or the console", async () => {
    const message =
      "Only a person who's a tenant admin may let people at their own email's domain join.";
    const { out } = await run(['sign-in', 'join-domains', 'allow', 'acme.example'], {
      allow: async () => {
        throw refused('join-domain-not-yours', message, 403);
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      `Error [auth]: ${message}\nFrom the CLI, allowing a domain takes the deployment operator's key: on a runtime serving one tenant, make one with the deployment's own token (\`kindgi tokens create --role=admin --capability=kindgi:system\`) and sign in with it (\`kindgi auth login --token\`). A tenant admin allows their own email's domain from the console's Sign-in page instead.\n`,
    );
  });

  test("where the operator manages sign-in: the operator's key only, no console way", async () => {
    const message = "The deployment's operator manages sign-in here.";
    const { out } = await run(['sign-in', 'join-domains', 'allow', 'acme.example'], {
      allow: async () => {
        throw refused('join-domains-operator-managed', message, 403);
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `Error [auth]: ${message}\nAllowing a domain here takes the deployment operator's key:`,
    );
    expect(out.stderr).not.toContain('console');
  });

  test('any other refusal is said as the API says it, with no hint', async () => {
    const message = 'gmail.com is a public mailbox domain.';
    const { out } = await run(['sign-in', 'join-domains', 'allow', 'gmail.com'], {
      allow: async () => {
        throw refused('join-domain-public', message, 400);
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/^Error \[[a-z-]+\]: gmail\.com is a public mailbox domain\.\n$/);
  });

  test('--quiet: no note', async () => {
    const { out } = await run(['sign-in', 'join-domains', 'allow', 'acme.example', '--quiet']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('');
  });
});

describe('kindgi sign-in join-domains remove', () => {
  test('stops the domain; says the people who joined stay', async () => {
    const { out, calls } = await run(['sign-in', 'join-domains', 'remove', 'acme.example']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['unregister', 'acme.example']]);
    expect(JSON.parse(out.stdout)).toEqual({ domain: 'acme.example', unregistered: true });
    expect(out.stderr).toBe(
      "People at acme.example can't join any more; the people who joined stay.\n",
    );
  });

  test("one the workspace doesn't allow: the API's refusal as it says it", async () => {
    const message = "This workspace doesn't let people at acme.example join.";
    const { out } = await run(['sign-in', 'join-domains', 'remove', 'acme.example'], {
      unregister: async () => {
        throw refused('join-domain-not-found', message, 404);
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(
      /^Error \[[a-z-]+\]: This workspace doesn't let people at acme\.example join\.\n$/,
    );
  });
});
