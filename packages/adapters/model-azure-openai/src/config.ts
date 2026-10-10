// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An Azure OpenAI registration's `adapter_config`, read and checked: where the resource is,
 * which API, how to sign in, and which deployment serves each model. Static: no network, no
 * secret read (`checkConfig` runs it at registration, the factory again when it builds).
 */

import type {
  AdapterConfigCheckInput,
  AdapterConfigProblem,
  ProviderMetadata,
} from '@kindgi/capabilities';

export const AZURE_OPENAI_ADAPTER_ID = '@kindgi/adapter-model-azure-openai';

/** The v1 API's Responses (the default), or Chat Completions. */
export const AZURE_OPENAI_APIS = ['responses', 'chat-completions'] as const;
export type AzureOpenAIApi = (typeof AZURE_OPENAI_APIS)[number];

/** A key (`secret_ref`, sent as `api-key`), or the runtime's Entra identity (a bearer token). */
export const AZURE_OPENAI_AUTHS = ['api-key', 'entra'] as const;
export type AzureOpenAIAuth = (typeof AZURE_OPENAI_AUTHS)[number];

export interface AzureOpenAIConfig {
  readonly endpoint: { readonly resourceName: string } | { readonly baseURL: string };
  readonly api: AzureOpenAIApi;
  readonly auth: AzureOpenAIAuth;
  /** With `auth: entra`: the scope the runtime's token is for, the endpoint's cloud's. */
  readonly scope?: string;
  /** The deployment for each registered model. */
  readonly deployments: ReadonlyMap<string, string>;
}

/**
 * The hosts the runtime's Entra token may go to, by cloud, each with the scope its tokens are
 * for. Nothing else gets the token: a registration naming another host could replay it against
 * every Azure OpenAI resource the runtime's identity holds a role on. A custom endpoint (a
 * gateway) takes `auth: api-key`.
 *
 * Sources (read 2026-10-09): the endpoints by cloud,
 * https://learn.microsoft.com/en-us/azure/azure-government/compare-azure-government-global-azure;
 * Azure Government's scope, https://learn.microsoft.com/en-us/dotnet/api/overview/azure/ai.openai-readme
 * (its Azure Government example). Microsoft's newer pages name the public
 * scope `https://ai.azure.com/.default`; `cognitiveservices.azure.com` is the one proven live
 * (2026-10-09), so it stays until a live run proves the other.
 */
export const AZURE_OPENAI_CLOUDS = [
  {
    cloud: 'Azure',
    hostSuffixes: ['.openai.azure.com', '.cognitiveservices.azure.com', '.services.ai.azure.com'],
    scope: 'https://cognitiveservices.azure.com/.default',
  },
  {
    cloud: 'Azure Government',
    hostSuffixes: ['.openai.azure.us', '.cognitiveservices.azure.us'],
    scope: 'https://cognitiveservices.azure.us/.default',
  },
] as const;

type AzureCloud = (typeof AZURE_OPENAI_CLOUDS)[number];

/** The cloud an Azure OpenAI host belongs to; undefined for any other host. */
export function azureCloudOf(hostname: string): AzureCloud | undefined {
  const host = hostname.toLowerCase();
  return AZURE_OPENAI_CLOUDS.find((c) =>
    c.hostSuffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length),
  );
}

/** The v1 API's path on an Azure OpenAI host. */
const V1_PATH = '/openai/v1';
const AZURE_HOSTS = AZURE_OPENAI_CLOUDS.flatMap((c) => c.hostSuffixes.map((s) => `*${s}`)).join(
  ', ',
);

const KEYS = ['resourceName', 'baseURL', 'deployments', 'api', 'auth'] as const;
/** A single DNS label, as Azure's resource names are. */
const RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/**
 * A deployment name as it can sit in this setting and in the request path: Azure sets no
 * character rule of its own (its ARM reference says only "string"; `gpt-6.1-sol` is a real
 * one), so only what would break the setting (`,`, `=`) or the path (`/`, whitespace) is refused,
 * and Azure answers for the rest.
 */
const DEPLOYMENT_NAME = /^[^\s,=/]+$/;

const at = (key: string) => `/adapter_config/${key}`;

/** The registration read, or every problem with it. */
export function readAzureOpenAIConfig(
  input: AdapterConfigCheckInput,
):
  | { readonly kind: 'ok'; readonly config: AzureOpenAIConfig }
  | { readonly kind: 'err'; readonly problems: readonly AdapterConfigProblem[] } {
  const config = input.config ?? {};
  const problems: AdapterConfigProblem[] = [];

  for (const key of Object.keys(config)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      problems.push({
        path: at(key),
        message: `adapter_config.${key} isn't an Azure OpenAI setting: it takes resourceName or baseURL, deployments, api and auth.`,
      });
    }
  }

  const auth = config.auth ?? 'api-key';
  const resourceName = config.resourceName;
  const baseURL = config.baseURL;
  let endpoint: AzureOpenAIConfig['endpoint'] | undefined;
  let cloud: AzureCloud | undefined;
  if (resourceName !== undefined && baseURL !== undefined) {
    problems.push({
      path: at('baseURL'),
      message:
        'adapter_config.resourceName and adapter_config.baseURL exclude each other: the resource, or a custom endpoint.',
    });
  } else if (resourceName !== undefined) {
    if (typeof resourceName !== 'string' || !RESOURCE_NAME.test(resourceName)) {
      problems.push({
        path: at('resourceName'),
        message:
          'adapter_config.resourceName must be the Azure OpenAI resource name, as in <name>.openai.azure.com (letters, digits, hyphens).',
      });
    } else {
      endpoint = { resourceName };
      cloud = AZURE_OPENAI_CLOUDS[0];
    }
  } else if (baseURL !== undefined) {
    const read = readBaseURL(baseURL, auth, problems);
    if (read !== undefined) {
      endpoint = { baseURL: read.baseURL };
      cloud = read.cloud;
    }
  } else {
    problems.push({
      path: at('resourceName'),
      message:
        'needs adapter_config.resourceName, the Azure OpenAI resource (as in <name>.openai.azure.com), or adapter_config.baseURL for a custom endpoint.',
    });
  }

  const api = config.api ?? 'responses';
  if (!(AZURE_OPENAI_APIS as readonly unknown[]).includes(api)) {
    problems.push({
      path: at('api'),
      message: `adapter_config.api must be one of ${AZURE_OPENAI_APIS.join(', ')}.`,
    });
  }

  if (!(AZURE_OPENAI_AUTHS as readonly unknown[]).includes(auth)) {
    problems.push({
      path: at('auth'),
      message: `adapter_config.auth must be one of ${AZURE_OPENAI_AUTHS.join(', ')}.`,
    });
  } else if (auth === 'api-key' && !input.hasSecretRef) {
    problems.push({
      path: '/secret_ref',
      message:
        "needs secret_ref: the resource's API key (or adapter_config.auth = entra, to sign in as the runtime's Azure identity).",
    });
  } else if (auth === 'entra' && input.hasSecretRef) {
    problems.push({
      path: '/secret_ref',
      message:
        "adapter_config.auth = entra signs in as the runtime's Azure identity: remove secret_ref.",
    });
  }
  if (auth === 'entra' && input.identities?.azure === false) {
    problems.push({
      path: at('auth'),
      message:
        "adapter_config.auth = entra needs the runtime's Azure identity (its managed identity; KINDGI_AZURE_CLIENT_ID names a user-assigned one), and this runtime has none.",
    });
  }

  const deployments = readDeployments(config.deployments, input.metadata, problems);

  if (problems.length > 0 || endpoint === undefined || deployments === undefined) {
    return { kind: 'err', problems };
  }
  return {
    kind: 'ok',
    config: {
      endpoint,
      api: api as AzureOpenAIApi,
      auth: auth as AzureOpenAIAuth,
      ...(auth === 'entra' && cloud !== undefined && { scope: cloud.scope }),
      deployments,
    },
  };
}

/**
 * A custom endpoint: https, with no credentials, query or fragment (they'd sit in the stored
 * settings); on an Azure OpenAI host, the v1 path (the portal's endpoint lacks it, and would
 * 404); and with `auth: entra`, an Azure OpenAI host only.
 */
function readBaseURL(
  value: unknown,
  auth: unknown,
  problems: AdapterConfigProblem[],
): { readonly baseURL: string; readonly cloud: AzureCloud | undefined } | undefined {
  const path = at('baseURL');
  const url = typeof value === 'string' ? parseUrl(value) : undefined;
  if (url === undefined || url.protocol !== 'https:') {
    problems.push({
      path,
      message: `adapter_config.baseURL must be an https URL (e.g. https://<name>.openai.azure.com${V1_PATH}).`,
    });
    return undefined;
  }
  const before = problems.length;
  const raw = value as string;
  if (url.username !== '' || url.password !== '') {
    problems.push({
      path,
      message:
        "adapter_config.baseURL can't hold credentials: a key goes in secret_ref, never in the URL.",
    });
  }
  if (url.search !== '' || raw.includes('?') || url.hash !== '' || raw.includes('#')) {
    problems.push({
      path,
      message:
        "adapter_config.baseURL can't hold a query or a fragment: a key goes in secret_ref, and the API version is the adapter's.",
    });
  }
  if (/\/\/+$/.test(url.pathname)) {
    problems.push({
      path,
      message:
        "adapter_config.baseURL can't end in more than one /: the adapter adds the API's path.",
    });
  }
  const cloud = azureCloudOf(url.hostname);
  if (cloud !== undefined && url.pathname.replace(/\/+$/, '') !== V1_PATH) {
    problems.push({
      path,
      message: `adapter_config.baseURL on an Azure OpenAI host must end in ${V1_PATH} (https://${url.hostname}${V1_PATH}), the v1 API.`,
    });
  }
  if (auth === 'entra' && cloud === undefined) {
    problems.push({
      path,
      message: `adapter_config.auth = entra sends the runtime's Azure token, which goes only to an Azure OpenAI host (${AZURE_HOSTS}); ${url.hostname} isn't one. A custom endpoint takes auth = api-key.`,
    });
  }
  return problems.length === before ? { baseURL: raw, cloud } : undefined;
}

/** `"model=deployment,model=deployment"`: every registered model, each a deployment Azure takes. */
function readDeployments(
  value: unknown,
  metadata: ProviderMetadata,
  problems: AdapterConfigProblem[],
): ReadonlyMap<string, string> | undefined {
  const path = at('deployments');
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push({
      path,
      message:
        'needs adapter_config.deployments, the deployment for each model: "model=deployment,…" (e.g. "gpt-6.1-sol=gpt-6-1-sol").',
    });
    return undefined;
  }
  const models = new Set(metadata.models.map((m) => m.name));
  const map = new Map<string, string>();
  const before = problems.length;
  for (const pair of value.split(',')) {
    const [model, deployment, extra] = pair.split('=').map((part) => part.trim());
    if (
      model === undefined ||
      model === '' ||
      deployment === undefined ||
      deployment === '' ||
      extra !== undefined
    ) {
      problems.push({
        path,
        message: `adapter_config.deployments has "${pair.trim()}": each entry is model=deployment.`,
      });
    } else if (map.has(model)) {
      problems.push({
        path,
        message: `adapter_config.deployments names ${model} twice: one deployment each.`,
      });
    } else if (!models.has(model)) {
      problems.push({
        path,
        message: `adapter_config.deployments names ${model}, which this registration doesn't list in metadata.models.`,
      });
    } else if (!DEPLOYMENT_NAME.test(deployment)) {
      problems.push({
        path,
        message: `adapter_config.deployments gives ${model} the deployment "${deployment}": a deployment name can't hold spaces, ",", "=" or "/".`,
      });
    } else map.set(model, deployment);
  }
  for (const model of models) {
    if (!map.has(model) && problems.length === before) {
      problems.push({
        path,
        message: `adapter_config.deployments has no deployment for ${model}.`,
      });
    }
  }
  return problems.length === before ? map : undefined;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
