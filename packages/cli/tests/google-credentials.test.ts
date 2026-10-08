// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  describeGoogleCredentials,
  gcloudApplicationDefaultPath,
  isVertexRegistration,
  resolveDevGoogleCredentials,
  vertexCredentialsHint,
} from '../src/dev/google-credentials.js';

let home: string;
let adc: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-gcreds-'));
  await mkdir(join(home, '.config', 'gcloud'), { recursive: true });
  adc = join(home, '.config', 'gcloud', 'application_default_credentials.json');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const userLogin = {
  type: 'authorized_user',
  client_id: 'acme-client.apps.googleusercontent.com',
  client_secret: 'not-a-real-secret',
  refresh_token: 'not-a-real-refresh-token',
};

describe('resolveDevGoogleCredentials', () => {
  test("unset or off: none, even when this machine's gcloud login and GOOGLE_APPLICATION_CREDENTIALS exist", async () => {
    await writeFile(adc, JSON.stringify(userLogin));
    const shellFile = join(home, 'shell.json');
    await writeFile(
      shellFile,
      JSON.stringify({ type: 'service_account', client_email: 'x@acme.iam.gserviceaccount.com' }),
    );
    const env = { HOME: home, GOOGLE_APPLICATION_CREDENTIALS: shellFile };
    for (const value of [undefined, '', '  ', 'off']) {
      expect(resolveDevGoogleCredentials(value, env)).toEqual({
        kind: 'ok',
        credentials: undefined,
      });
    }
  });

  test('adc: the gcloud login, named without reading a token', async () => {
    await writeFile(adc, JSON.stringify(userLogin));
    expect(resolveDevGoogleCredentials('adc', { HOME: home })).toEqual({
      kind: 'ok',
      credentials: { path: adc, who: 'your gcloud application-default login (a user account)' },
    });
  });

  test('adc with no gcloud login: refused, saying how to make one', () => {
    const out = resolveDevGoogleCredentials('adc', { HOME: home });
    expect(out).toMatchObject({ kind: 'error' });
    if (out.kind === 'error') {
      expect(out.message).toBe(
        `KINDGI_DEV_GOOGLE_CREDENTIALS=adc, but there's no gcloud application-default login at ${adc}. Run \`gcloud auth application-default login\`, or set KINDGI_DEV_GOOGLE_CREDENTIALS to a credentials file's absolute path.`,
      );
    }
  });

  test('an absolute path: that file; a relative one, a missing one, a non-credentials file: refused', async () => {
    const sa = join(home, 'sa.json');
    await writeFile(
      sa,
      JSON.stringify({
        type: 'service_account',
        client_email: 'runner@acme.iam.gserviceaccount.com',
        private_key: 'x',
      }),
    );
    expect(resolveDevGoogleCredentials(sa, { HOME: home })).toEqual({
      kind: 'ok',
      credentials: { path: sa, who: 'service account runner@acme.iam.gserviceaccount.com' },
    });
    expect(resolveDevGoogleCredentials('sa.json', { HOME: home })).toMatchObject({
      kind: 'error',
      message: expect.stringContaining(
        'must be `adc` (your gcloud application-default login), the absolute path of a Google credentials file, or `off`. Got "sa.json".',
      ),
    });
    expect(resolveDevGoogleCredentials(join(home, 'gone.json'), { HOME: home })).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('gone.json" isn\'t a file.'),
    });
    const notCreds = join(home, 'notes.txt');
    await writeFile(notCreds, 'hello');
    expect(resolveDevGoogleCredentials(notCreds, { HOME: home })).toMatchObject({
      kind: 'error',
      message: `KINDGI_DEV_GOOGLE_CREDENTIALS: ${notCreds} isn't a Google credentials file (JSON with a "type").`,
    });
  });
});

describe('describeGoogleCredentials', () => {
  test('whose they are, from non-secret fields only', async () => {
    const file = join(home, 'c.json');
    const who = async (body: unknown) => {
      await writeFile(file, JSON.stringify(body));
      return describeGoogleCredentials(file);
    };
    expect(await who(userLogin)).toBe('your gcloud application-default login (a user account)');
    expect(
      await who({ ...userLogin, account: 'dev@acme.example', quota_project_id: 'acme-billing' }),
    ).toBe('your gcloud application-default login, dev@acme.example, quota project acme-billing');
    expect(
      await who({
        type: 'impersonated_service_account',
        service_account_impersonation_url:
          'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/deployer@acme.iam.gserviceaccount.com:generateAccessToken',
        source_credentials: userLogin,
      }),
    ).toBe('impersonating deployer@acme.iam.gserviceaccount.com');
    expect(await who({ type: 'external_account', audience: '//iam.googleapis.com/x' })).toBe(
      'an external account (workload identity federation)',
    );
    expect(await who({ type: 'gdch_service_account' })).toBe(
      'a "gdch_service_account" credentials file',
    );
    expect(await who({ client_id: 'x' })).toBeUndefined();
    for (const secret of ['not-a-real-secret', 'not-a-real-refresh-token']) {
      expect(await who(userLogin)).not.toContain(secret);
    }
  });
});

test("gcloud's login file: CLOUDSDK_CONFIG when set, else ~/.config/gcloud", () => {
  expect(gcloudApplicationDefaultPath({ HOME: '/home/dev' })).toBe(
    '/home/dev/.config/gcloud/application_default_credentials.json',
  );
  expect(
    gcloudApplicationDefaultPath({ HOME: '/home/dev', CLOUDSDK_CONFIG: '/etc/gcloud-dev' }),
  ).toBe('/etc/gcloud-dev/application_default_credentials.json');
  expect(gcloudApplicationDefaultPath({})).toBeUndefined();
});

test('a Vertex registration: the Gemini adapter, not on the Developer API', () => {
  expect(
    isVertexRegistration({
      adapter_id: '@kindgi/adapter-model-gemini',
      adapter_config: { project: 'acme' },
    }),
  ).toBe(true);
  expect(
    isVertexRegistration({
      adapter_id: '@kindgi/adapter-model-gemini',
      adapter_config: { api: 'developer' },
    }),
  ).toBe(false);
  expect(isVertexRegistration({ adapter_id: '@kindgi/adapter-model-anthropic' })).toBe(false);
});

test('the hint names the providers, and offers a GOOGLE_APPLICATION_CREDENTIALS the shell sets to a file', async () => {
  const shellFile = join(home, 'shell.json');
  await writeFile(shellFile, '{"type":"service_account"}');
  expect(vertexCredentialsHint(['gemini'], {})).toBe(
    "Provider gemini (Vertex AI) has no Google credentials: set KINDGI_DEV_GOOGLE_CREDENTIALS=adc (or a credentials file), in the pack's .env or the shell, and restart kindgi dev.",
  );
  // /dev/null (which only turns it off) or a missing file: not offered.
  for (const off of ['/dev/null', join(home, 'gone.json')]) {
    expect(vertexCredentialsHint(['gemini'], { GOOGLE_APPLICATION_CREDENTIALS: off })).toContain(
      '(or a credentials file)',
    );
  }
  expect(
    vertexCredentialsHint(['gemini', 'vertex-eu'], { GOOGLE_APPLICATION_CREDENTIALS: shellFile }),
  ).toBe(
    "Providers gemini, vertex-eu (Vertex AI) have no Google credentials: set KINDGI_DEV_GOOGLE_CREDENTIALS=adc, or KINDGI_DEV_GOOGLE_CREDENTIALS=$GOOGLE_APPLICATION_CREDENTIALS, in the pack's .env or the shell, and restart kindgi dev.",
  );
});
