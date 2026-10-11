// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An Amazon Bedrock registration, read and checked: the region (`metadata.region`), how to sign
 * in, and the endpoint. Static: no network, no secret read (`checkConfig` runs it at
 * registration, the factory again when it builds).
 */

import type { AdapterConfigCheckInput, AdapterConfigProblem } from '@kindgi/capabilities';

export const BEDROCK_ADAPTER_ID = '@kindgi/adapter-model-bedrock';

/**
 * The runtime's AWS identity, requests signed with SigV4 (the default), or a Bedrock API key
 * (`secret_ref`, sent as a bearer token), which AWS recommends for exploration only.
 */
export const BEDROCK_AUTHS = ['aws-identity', 'api-key'] as const;
export type BedrockAuth = (typeof BEDROCK_AUTHS)[number];

export interface BedrockConfig {
  /** The AWS region the requests go to and are signed for. */
  readonly region: string;
  /** The `bedrock-runtime` endpoint: the region's own, or the registration's `baseURL`. */
  readonly baseURL: string;
  readonly auth: BedrockAuth;
}

const KEYS = ['auth', 'baseURL'] as const;
/** An AWS region name: `us-east-2`, `us-gov-west-1`, `eusc-de-east-1`. */
const REGION = /^[a-z]{2,4}(?:-[a-z]+)+-\d{1,2}$/;
/**
 * The DNS suffix of each AWS partition other than `aws` (`amazonaws.com`), by region prefix:
 * the same table `@ai-sdk/amazon-bedrock` builds its default endpoint from. The runtime's AWS
 * identity keeps a copy for its STS endpoint, until both read one shared module.
 */
const PARTITION_DNS_SUFFIXES: readonly (readonly [prefix: string, suffix: string])[] = [
  ['cn-', 'amazonaws.com.cn'],
  ['us-iso-', 'c2s.ic.gov'],
  ['us-isob-', 'sc2s.sgov.gov'],
  ['eu-isoe-', 'cloud.adc-e.uk'],
  ['us-isof-', 'csp.hci.ic.gov'],
  ['eusc-', 'amazonaws.eu'],
];

const at = (key: string) => `/adapter_config/${key}`;

/** The DNS suffix of a region's partition: `amazonaws.com`, `amazonaws.com.cn`, … */
export function partitionDnsSuffix(region: string): string {
  return (
    PARTITION_DNS_SUFFIXES.find(([prefix]) => region.startsWith(prefix))?.[1] ?? 'amazonaws.com'
  );
}

/** The region's own `bedrock-runtime` endpoint. */
export function bedrockRuntimeEndpoint(region: string): string {
  return `https://bedrock-runtime.${region}.${partitionDnsSuffix(region)}`;
}

/**
 * Whether a host is Bedrock's runtime in this region: its own endpoint, its FIPS endpoint, or
 * an interface VPC endpoint's own name. Only these get requests signed with the runtime's AWS
 * credentials: a registration naming another host would receive the session token and a
 * signature. Sources (read 2026-10-09): https://docs.aws.amazon.com/general/latest/gr/bedrock.html
 * (the endpoints and FIPS endpoints) and
 * https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html
 * (`vpce-id.bedrock-runtime.region.vpce.amazonaws.com`).
 */
export function isBedrockRuntimeHost(hostname: string, region: string): boolean {
  const host = hostname.toLowerCase();
  const tail = `${region}.${partitionDnsSuffix(region)}`;
  if (host === `bedrock-runtime.${tail}` || host === `bedrock-runtime-fips.${tail}`) return true;
  const vpce = `.bedrock-runtime.${region}.vpce.${partitionDnsSuffix(region)}`;
  return host.endsWith(vpce) && /^vpce-[a-z0-9-]+$/.test(host.slice(0, -vpce.length));
}

/** The registration read, or every problem with it. */
export function readBedrockConfig(
  input: AdapterConfigCheckInput,
):
  | { readonly kind: 'ok'; readonly config: BedrockConfig }
  | { readonly kind: 'err'; readonly problems: readonly AdapterConfigProblem[] } {
  const config = input.config ?? {};
  const problems: AdapterConfigProblem[] = [];

  for (const key of Object.keys(config)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      problems.push({
        path: at(key),
        message: `adapter_config.${key} isn't an Amazon Bedrock setting: it takes auth and baseURL (the region is metadata.region).`,
      });
    }
  }

  const region = input.metadata.region;
  const regionOk = typeof region === 'string' && REGION.test(region);
  if (!regionOk) {
    problems.push({
      path: '/metadata/region',
      message: `metadata.region must be the AWS region Bedrock runs in (e.g. us-east-2): the requests go to it and are signed for it. Got "${String(region)}".`,
    });
  }

  const auth = config.auth ?? 'aws-identity';
  const baseURL = config.baseURL;
  if (baseURL !== undefined) {
    readBaseURL(baseURL, auth, regionOk ? (region as string) : undefined, problems);
  }

  if (!(BEDROCK_AUTHS as readonly unknown[]).includes(auth)) {
    problems.push({
      path: at('auth'),
      message: `adapter_config.auth must be one of ${BEDROCK_AUTHS.join(', ')}.`,
    });
  } else if (auth === 'api-key' && !input.hasSecretRef) {
    problems.push({
      path: '/secret_ref',
      message:
        "adapter_config.auth = api-key needs secret_ref: the Bedrock API key (or leave auth unset, to sign in as the runtime's AWS identity).",
    });
  } else if (auth === 'aws-identity' && input.hasSecretRef) {
    problems.push({
      path: '/secret_ref',
      message:
        "adapter_config.auth = aws-identity (the default) signs in as the runtime's AWS identity: remove secret_ref, or set auth = api-key for a Bedrock API key.",
    });
  }
  if (auth === 'aws-identity' && input.identities?.aws === false) {
    problems.push({
      path: at('auth'),
      message:
        "adapter_config.auth = aws-identity (the default) needs the runtime's AWS identity (KINDGI_AWS_IDENTITY says where it comes from), and this runtime has none. Or set auth = api-key for a Bedrock API key.",
    });
  }

  if (problems.length > 0) return { kind: 'err', problems };
  return {
    kind: 'ok',
    config: {
      region,
      baseURL: (baseURL as string | undefined) ?? bedrockRuntimeEndpoint(region),
      auth: auth as BedrockAuth,
    },
  };
}

/**
 * A custom endpoint: https, with no credentials, query or fragment (they'd sit in the stored
 * settings); Bedrock's own host at its root; with `auth: aws-identity`, Bedrock's runtime in
 * the region only. A gateway (with `auth: api-key`) is any host and path.
 */
function readBaseURL(
  value: unknown,
  auth: unknown,
  region: string | undefined,
  problems: AdapterConfigProblem[],
): void {
  const path = at('baseURL');
  const url = typeof value === 'string' ? parseUrl(value) : undefined;
  if (url === undefined || url.protocol !== 'https:') {
    problems.push({
      path,
      message:
        'adapter_config.baseURL must be an https URL: a bedrock-runtime endpoint of your own, such as a VPC endpoint or a FIPS endpoint.',
    });
    return;
  }
  const raw = value as string;
  if (url.username !== '' || url.password !== '') {
    problems.push({
      path,
      message:
        "adapter_config.baseURL can't hold credentials: a key goes in secret_ref, never in the URL.",
    });
  }
  if (url.search !== '' || raw.includes('?') || url.hash !== '' || raw.includes('#')) {
    problems.push({ path, message: "adapter_config.baseURL can't hold a query or a fragment." });
  }
  const bedrockHost = region !== undefined && isBedrockRuntimeHost(url.hostname, region);
  if (bedrockHost && url.pathname !== '/' && url.pathname !== '') {
    problems.push({
      path,
      message: `adapter_config.baseURL is an endpoint's root (https://${url.host}), with no path: the adapter adds the API's.`,
    });
  }
  if (auth === 'aws-identity' && region !== undefined && !bedrockHost) {
    const suffix = partitionDnsSuffix(region);
    problems.push({
      path,
      message: `adapter_config.auth = aws-identity signs requests with the runtime's AWS credentials, which go only to Bedrock's runtime in ${region} (bedrock-runtime.${region}.${suffix}, bedrock-runtime-fips.${region}.${suffix}, or a VPC endpoint's vpce-….bedrock-runtime.${region}.vpce.${suffix}); ${url.hostname} isn't one. A VPC endpoint with private DNS needs no baseURL; another endpoint takes auth = api-key.`,
    });
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
