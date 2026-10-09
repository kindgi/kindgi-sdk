// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A secret in AWS Secrets Manager, for `kindgi license renew` and `enroll`:
 * `aws:<region>:<secret name>`, or `aws:<the secret's ARN>`. Reads
 * `AWSCURRENT` (`GetSecretValue`), writes a new version
 * (`PutSecretValue`), signed with Signature Version 4.
 *
 * Credentials, the first that answers: the environment
 * (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; what
 * CI sets), a web identity (`AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`:
 * EKS IRSA, CI's OIDC), the container endpoint (ECS, EKS Pod Identity),
 * the instance's role (IMDSv2 only), and on a laptop the AWS CLI's
 * (`aws configure export-credentials`: profiles, SSO).
 */

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { type CloudDeps, CloudSecretError } from './cloud.js';
import type { SecretStore } from './stores.js';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const REGION = /^[a-z]{2,4}(?:-[a-z]+)+-\d{1,2}$/;
const ARN =
  /^arn:aws(?:-[a-z]+)*:secretsmanager:([a-z]{2,4}(?:-[a-z]+)+-\d{1,2}):\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
const METADATA_TIMEOUT_MS = 1500;

/** The DNS suffix of a region's partition: China's differs. */
const suffixOf = (region: string) =>
  region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';

export function awsSecretStore(ref: string, deps: CloudDeps): SecretStore | undefined {
  const arn = ARN.exec(ref);
  let region: string;
  let secretId: string;
  if (arn !== null) {
    region = arn[1] ?? '';
    secretId = ref;
  } else {
    const colon = ref.indexOf(':');
    region = ref.slice(0, colon);
    secretId = ref.slice(colon + 1);
    if (colon === -1 || !REGION.test(region) || !SECRET_NAME.test(secretId)) return undefined;
  }
  const describe = `the Secrets Manager secret ${secretId} (${region})`;
  // Found once per store: a renewal reads, then maybe writes.
  let credentials: Promise<AwsCredentials> | undefined;
  const send = async (target: string, body: Record<string, unknown>) => {
    credentials ??= awsCredentials(deps, region);
    const host = `secretsmanager.${region}.${suffixOf(region)}`;
    const payload = JSON.stringify(body);
    const headers = signV4({
      method: 'POST',
      host,
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `secretsmanager.${target}`,
      },
      body: payload,
      region,
      service: 'secretsmanager',
      credentials: await credentials,
      now: new Date(),
    });
    return deps.fetch(`https://${host}/`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
  };
  return {
    async read() {
      const res = await send('GetSecretValue', { SecretId: secretId });
      if (!res.ok) {
        const error = await awsError(res);
        if (error.type === 'ResourceNotFoundException') return undefined;
        throw refused(describe, res.status, error, 'secretsmanager:GetSecretValue');
      }
      const value = ((await res.json()) as { SecretString?: string }).SecretString?.trim() ?? '';
      return value === '' ? undefined : value;
    },
    async write(value) {
      const res = await send('PutSecretValue', { SecretId: secretId, SecretString: value });
      if (!res.ok) {
        throw refused(describe, res.status, await awsError(res), 'secretsmanager:PutSecretValue');
      }
    },
    describe,
  };
}

async function awsError(
  res: Response,
): Promise<{ readonly type?: string; readonly message?: string }> {
  const body = (await res.json().catch(() => ({}))) as {
    __type?: string;
    message?: string;
    Message?: string;
  };
  const type = body.__type?.split('#').pop();
  const message = body.message ?? body.Message;
  return { ...(type !== undefined && { type }), ...(message !== undefined && { message }) };
}

function refused(
  what: string,
  status: number,
  error: { readonly type?: string; readonly message?: string },
  action: string,
): CloudSecretError {
  const why = error.type ?? error.message;
  const denied = error.type === 'AccessDeniedException' || status === 403;
  return new CloudSecretError(
    `${what} answered ${status}${why !== undefined ? ` (${why})` : ''}.${denied ? ` The identity running this needs ${action} on that secret.` : ''}`,
  );
}

// ---- Signature Version 4 ------------------------------------------------------------

/** The headers a SigV4-signed request carries: the given ones, `host`, `x-amz-date`, the token, `authorization`. */
export function signV4(input: {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: input.host,
    'x-amz-date': amzDate,
    ...(input.credentials.sessionToken !== undefined && {
      'x-amz-security-token': input.credentials.sessionToken,
    }),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const query = Object.entries(input.query ?? {})
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    input.method,
    input.path,
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    signedHeaders,
    sha256Hex(input.body),
  ].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = [date, input.region, input.service, 'aws4_request'].reduce<Buffer>(
    (k, part) => hmac(k, part),
    Buffer.from(`AWS4${input.credentials.secretAccessKey}`, 'utf8'),
  );
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// ---- credentials ----------------------------------------------------------------------

/** The first credentials that answer (see the module's comment), or a message saying none did. */
export async function awsCredentials(deps: CloudDeps, region: string): Promise<AwsCredentials> {
  const sources = [fromEnv, fromWebIdentity, fromContainer, fromInstance, fromAwsCli] as const;
  for (const source of sources) {
    const found = await source(deps, region);
    if (found !== undefined) return found;
  }
  throw new CloudSecretError(
    "No AWS credentials here: none in the environment, no web identity, no container or instance role, and `aws configure export-credentials` gave nothing. Run it where the deployment's role is, or sign in with the AWS CLI.",
  );
}

async function fromEnv(deps: CloudDeps): Promise<AwsCredentials | undefined> {
  const accessKeyId = deps.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = deps.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = deps.env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** STS AssumeRoleWithWebIdentity (unsigned), regionally. */
async function fromWebIdentity(
  deps: CloudDeps,
  region: string,
): Promise<AwsCredentials | undefined> {
  const roleArn = deps.env.AWS_ROLE_ARN;
  const tokenFile = deps.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  if (!roleArn || !tokenFile) return undefined;
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const params = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: 'kindgi-license',
    WebIdentityToken: token,
  });
  const res = await deps.fetch(`https://sts.${region}.${suffixOf(region)}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: params.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new CloudSecretError(`STS refused the web identity for ${roleArn} (${res.status}).`);
  }
  const body = (await res.json()) as {
    AssumeRoleWithWebIdentityResponse?: {
      AssumeRoleWithWebIdentityResult?: {
        Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
      };
    };
  };
  const c = body.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
  return asCredentials(c?.AccessKeyId, c?.SecretAccessKey, c?.SessionToken);
}

/** ECS's relative URI, or EKS Pod Identity's full URI and its token. */
async function fromContainer(deps: CloudDeps): Promise<AwsCredentials | undefined> {
  const relative = deps.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = deps.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const url = relative ? `http://169.254.170.2${relative}` : full;
  if (!url) return undefined;
  const tokenFile = deps.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  const token = tokenFile
    ? (await readFile(tokenFile, 'utf8')).trim()
    : deps.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  const res = await deps.fetch(url, {
    headers: token ? { authorization: token } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok)
    throw new CloudSecretError(`The container credentials endpoint answered ${res.status}.`);
  const c = (await res.json()) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    Token?: string;
  };
  return asCredentials(c.AccessKeyId, c.SecretAccessKey, c.Token);
}

/** The instance's role, IMDSv2 only: no session token, no credentials. */
async function fromInstance(deps: CloudDeps): Promise<AwsCredentials | undefined> {
  const imds = 'http://169.254.169.254/latest';
  try {
    const t = await deps.fetch(`${imds}/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!t.ok) return undefined;
    const headers = { 'x-aws-ec2-metadata-token': (await t.text()).trim() };
    const roles = await deps.fetch(`${imds}/meta-data/iam/security-credentials/`, {
      headers,
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    const role = roles.ok ? (await roles.text()).split('\n')[0]?.trim() : undefined;
    if (!role) return undefined;
    const res = await deps.fetch(`${imds}/meta-data/iam/security-credentials/${role}`, {
      headers,
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const c = (await res.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
    };
    return asCredentials(c.AccessKeyId, c.SecretAccessKey, c.Token);
  } catch {
    return undefined;
  }
}

async function fromAwsCli(deps: CloudDeps): Promise<AwsCredentials | undefined> {
  try {
    const out = await deps.run('aws', ['configure', 'export-credentials', '--format', 'process']);
    const c = JSON.parse(out) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
    };
    return asCredentials(c.AccessKeyId, c.SecretAccessKey, c.SessionToken);
  } catch {
    return undefined;
  }
}

function asCredentials(
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
  sessionToken: string | undefined,
): AwsCredentials | undefined {
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}
