// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Secrets in AWS Secrets Manager, through stand-ins: Signature Version 4
 * against the example AWS publishes (its signature, to the character),
 * the two calls a store makes, and where its credentials come from, in
 * order. Never a real account, never this machine's credentials.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { awsCredentials, signV4 } from '../src/license/aws.js';
import type { CloudDeps } from '../src/license/cloud.js';
import { SecretRefError, secretStoreFor } from '../src/license/stores.js';

test('SigV4: the example AWS documents (IAM ListUsers, 2015-08-30), to the signature', () => {
  const headers = signV4({
    method: 'GET',
    host: 'iam.amazonaws.com',
    path: '/',
    query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    region: 'us-east-1',
    service: 'iam',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    },
    now: new Date('2015-08-30T12:36:00Z'),
  });
  expect(headers.authorization).toBe(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  );
  expect(headers['x-amz-date']).toBe('20150830T123600Z');
});

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function aws(
  routes: Record<string, (req: Seen) => { status: number; body?: unknown; text?: string }>,
  env: Record<string, string> = {},
  cli: Record<string, string> = {},
) {
  const seen: Seen[] = [];
  const ran: string[] = [];
  const deps: CloudDeps = {
    env,
    fetch: (async (input: string, init?: RequestInit) => {
      const req: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(init?.body !== undefined && { body: String(init.body) }),
      };
      seen.push(req);
      const route = Object.keys(routes).find((prefix) => req.url.startsWith(prefix));
      if (route === undefined) throw new TypeError('fetch failed');
      const out = routes[route]?.(req) ?? { status: 500 };
      return new Response(out.text ?? (out.body === undefined ? null : JSON.stringify(out.body)), {
        status: out.status,
      });
    }) as unknown as typeof fetch,
    run: async (command, args) => {
      ran.push([command, ...args].join(' '));
      const out = cli[command];
      if (out === undefined) throw new Error(`${command}: not found`);
      return out;
    },
  };
  return { deps, seen, ran };
}

const ENV_CREDS = {
  AWS_ACCESS_KEY_ID: 'AKIAENV',
  AWS_SECRET_ACCESS_KEY: 'env-secret',
  AWS_SESSION_TOKEN: 'env-session',
};
const SM = 'https://secretsmanager.us-east-2.amazonaws.com/';

describe('Secrets Manager', () => {
  test('GetSecretValue, then PutSecretValue: signed, regional, by name', async () => {
    const c = aws(
      {
        [SM]: (req) =>
          req.headers['x-amz-target'] === 'secretsmanager.GetSecretValue'
            ? { status: 200, body: { SecretString: 'kgi_lk_current.sig' } }
            : { status: 200, body: { VersionId: 'v2' } },
      },
      ENV_CREDS,
    );
    const store = secretStoreFor('aws:us-east-2:kindgi/license-key', { cloud: c.deps });
    expect(await store.read()).toBe('kgi_lk_current.sig');
    await store.write('kgi_lk_next.sig');
    const [get, put] = c.seen;
    expect(JSON.parse(get?.body ?? '')).toEqual({ SecretId: 'kindgi/license-key' });
    expect(JSON.parse(put?.body ?? '')).toEqual({
      SecretId: 'kindgi/license-key',
      SecretString: 'kgi_lk_next.sig',
    });
    expect(put?.headers['x-amz-target']).toBe('secretsmanager.PutSecretValue');
    expect(put?.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(put?.headers['x-amz-security-token']).toBe('env-session');
    expect(put?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAENV\/\d{8}\/us-east-2\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    expect(store.describe).toBe('the Secrets Manager secret kindgi/license-key (us-east-2)');
  });

  test('an ARN names its own region; China is amazonaws.com.cn', async () => {
    const arn =
      'arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:kindgi/license-key-AbCdEf';
    const c = aws(
      {
        'https://secretsmanager.cn-north-1.amazonaws.com.cn/': () => ({
          status: 200,
          body: { SecretString: 'v' },
        }),
      },
      ENV_CREDS,
    );
    expect(await secretStoreFor(`aws:${arn}`, { cloud: c.deps }).read()).toBe('v');
    expect(JSON.parse(c.seen[0]?.body ?? '')).toEqual({ SecretId: arn });
  });

  test('no such secret reads as none; denied says the action it needs', async () => {
    const c = aws(
      {
        [SM]: (req) =>
          req.headers['x-amz-target'] === 'secretsmanager.GetSecretValue'
            ? { status: 400, body: { __type: 'ResourceNotFoundException', message: 'not found' } }
            : {
                status: 400,
                body: { __type: 'com.amazon.coral.service#AccessDeniedException', Message: 'no' },
              },
      },
      ENV_CREDS,
    );
    const store = secretStoreFor('aws:us-east-2:kindgi/license-key', { cloud: c.deps });
    expect(await store.read()).toBeUndefined();
    await expect(store.write('kgi_lk_never.printed')).rejects.toThrow(
      'the Secrets Manager secret kindgi/license-key (us-east-2) answered 400 (AccessDeniedException). The identity running this needs secretsmanager:PutSecretValue on that secret.',
    );
  });

  test('references that aren’t one are refused', () => {
    for (const ref of [
      'aws:kindgi/license-key',
      'aws:mars-1:x',
      'aws:us-east-2:',
      'aws:arn:aws:s3:::bucket',
    ]) {
      expect(() => secretStoreFor(ref), ref).toThrow(SecretRefError);
    }
  });
});

describe('where the credentials come from, the first that answers', () => {
  test('the environment first (what CI sets)', async () => {
    const c = aws({}, ENV_CREDS);
    expect(await awsCredentials(c.deps, 'us-east-2')).toEqual({
      accessKeyId: 'AKIAENV',
      secretAccessKey: 'env-secret',
      sessionToken: 'env-session',
    });
    expect(c.seen).toEqual([]);
  });

  test('a web identity: the token file to regional STS, for the role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kindgi-aws-'));
    writeFileSync(join(dir, 'token'), 'eyJ.irsa\n');
    const c = aws(
      {
        'https://sts.eu-west-1.amazonaws.com/': () => ({
          status: 200,
          body: {
            AssumeRoleWithWebIdentityResponse: {
              AssumeRoleWithWebIdentityResult: {
                Credentials: { AccessKeyId: 'ASIAWEB', SecretAccessKey: 's', SessionToken: 't' },
              },
            },
          },
        }),
      },
      {
        AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/kindgi',
        AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, 'token'),
      },
    );
    expect((await awsCredentials(c.deps, 'eu-west-1')).accessKeyId).toBe('ASIAWEB');
    const sent = new URLSearchParams(c.seen[0]?.body);
    expect(sent.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/kindgi');
    expect(sent.get('WebIdentityToken')).toBe('eyJ.irsa');
  });

  test('the container endpoint (ECS), and EKS Pod Identity with its token file', async () => {
    const ecs = aws(
      {
        'http://169.254.170.2/v2/credentials/abc': () => ({
          status: 200,
          body: { AccessKeyId: 'ASIAECS', SecretAccessKey: 's', Token: 't' },
        }),
      },
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' },
    );
    expect((await awsCredentials(ecs.deps, 'us-east-2')).accessKeyId).toBe('ASIAECS');

    const dir = mkdtempSync(join(tmpdir(), 'kindgi-aws-'));
    writeFileSync(join(dir, 'pod-token'), 'pod-identity-token');
    const eks = aws(
      {
        'http://169.254.170.23/v1/credentials': (req) => {
          expect(req.headers.authorization).toBe('pod-identity-token');
          return {
            status: 200,
            body: { AccessKeyId: 'ASIAPOD', SecretAccessKey: 's', Token: 't' },
          };
        },
      },
      {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: join(dir, 'pod-token'),
      },
    );
    expect((await awsCredentials(eks.deps, 'us-east-2')).accessKeyId).toBe('ASIAPOD');
  });

  test('the instance role, IMDSv2: a session token first, and no request without it', async () => {
    const c = aws({
      'http://169.254.169.254/latest/api/token': (req) => {
        expect(req.method).toBe('PUT');
        return { status: 200, text: 'imds-token' };
      },
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/kindgi-role': (req) => {
        expect(req.headers['x-aws-ec2-metadata-token']).toBe('imds-token');
        return { status: 200, body: { AccessKeyId: 'ASIAEC2', SecretAccessKey: 's', Token: 't' } };
      },
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/': (req) => {
        expect(req.headers['x-aws-ec2-metadata-token']).toBe('imds-token');
        return { status: 200, text: 'kindgi-role\n' };
      },
    });
    expect((await awsCredentials(c.deps, 'us-east-2')).accessKeyId).toBe('ASIAEC2');
    expect(
      c.seen.every(
        (r) => r.method === 'PUT' || r.headers['x-aws-ec2-metadata-token'] === 'imds-token',
      ),
    ).toBe(true);
  });

  test('a laptop: the AWS CLI’s; nothing at all: said', async () => {
    const laptop = aws(
      {},
      {},
      { aws: '{"Version":1,"AccessKeyId":"ASIACLI","SecretAccessKey":"s","SessionToken":"t"}' },
    );
    expect((await awsCredentials(laptop.deps, 'us-east-2')).accessKeyId).toBe('ASIACLI');
    expect(laptop.ran).toEqual(['aws configure export-credentials --format process']);
    await expect(awsCredentials(aws({}).deps, 'us-east-2')).rejects.toThrow(
      'No AWS credentials here',
    );
  });
});
