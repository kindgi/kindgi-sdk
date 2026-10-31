// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type ThinkingLevel as GeminiThinkingConfigLevel,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import type {
  AdapterConfigCheckInput,
  AdapterConfigProblem,
  AdapterFactory,
  AdapterFactoryEntry,
  AdapterFactoryInput,
  ModelCallInput,
  ModelCallResult,
  ModelCallWarning,
  ModelInfo,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';
import { adapterConfigError, fileParts, samplingFor, thinkingFor } from '@kindgi/capabilities';
import { createAttemptCounter } from '@kindgi/capabilities/attempts';
import { createClientsByKey } from '@kindgi/capabilities/clients-by-key';
import { headerValueProblem } from '@kindgi/types';

import { type GeminiModelInfo, computeCostUsd, toFrameworkUsage } from './cost.js';
import { fromGeminiResponse, toGeminiFunctions, toGeminiRequest } from './translate.js';

/** The adapter id servers register `geminiAdapterFactory` under. */
export const GEMINI_ADAPTER_ID = '@kindgi/adapter-model-gemini';

/** The slice of the SDK client the adapter calls. Tests pass a fake. */
export interface GeminiClient {
  readonly models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
  };
}

export interface GeminiProviderOptions {
  /**
   * Metadata surfaced to the router. `models[]` lists every model the
   * caller expects to invoke through this connection; per-model `cost`
   * takes Gemini's cached-token and long-context rates.
   */
  readonly metadata: Omit<ProviderMetadata, 'models'> & {
    readonly models: readonly GeminiModelInfo[];
  };
  /**
   * The Vertex AI project and location (`global`, or a region such as
   * `us-central1`): Gemini on Vertex AI, the route for a regulated
   * deployment (its data residency, its IAM). Set this or `apiKey`.
   */
  readonly vertex?: { readonly project: string; readonly location: string };
  /**
   * A service-account key (its JSON), resolved on every call, for Vertex.
   * Absent: Google Application Default Credentials — `gcloud auth
   * application-default login` on a laptop, the attached service account
   * on Cloud Run and other Google Cloud runtimes.
   */
  readonly credentials?: () => string | Promise<string>;
  /**
   * A Gemini Developer API key (from Google AI Studio), resolved on every
   * call: Gemini without a Google Cloud project. Set this or `vertex`.
   */
  readonly apiKey?: () => string | Promise<string>;
  /** An injected client, used as is (tests). `vertex`, `credentials` and `apiKey` are then unused. */
  readonly client?: GeminiClient;
}

/** What a call sends about thinking, and what it says about it. */
interface GeminiThinking {
  /** Gemini's `thinkingConfig.thinkingLevel`, upper-cased. Absent: none is sent. */
  readonly thinkingLevel?: string;
  /** The call's record of it (`ModelCallResult.thinking`). */
  readonly result?: NonNullable<ModelCallResult['thinking']>;
  readonly warnings: readonly ModelCallWarning[];
}

/**
 * The level a call sends (Gemini 3's `thinkingLevel`): the call's level,
 * or the model's `thinking.default` when it asks none, rounded to one the
 * model takes (`thinkingFor`). `lowest` sends the model's
 * `thinking.lowest`. A model with no `thinking` gets none. Gemini 2.5
 * takes a token budget instead, so it isn't sent one.
 */
function thinkingLevelFor(input: ModelCallInput, model: ModelInfo): GeminiThinking {
  const { level, warnings } = thinkingFor(model, input);
  if (level === undefined || model.thinking === undefined) return { warnings };
  const thinkingLevel = (level === 'lowest' ? model.thinking.lowest : level).toUpperCase();
  return { thinkingLevel, result: { level, sent: { thinkingLevel } }, warnings };
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * The Gemini Developer API host. Given explicitly in `httpOptions.baseUrl` so
 * the adapter takes its host from configuration, not from `GOOGLE_GEMINI_BASE_URL`
 * in the server's environment: left unset, `@google/genai` reads that variable
 * (its `getBaseUrl`).
 */
const GEMINI_DEVELOPER_BASE_URL = 'https://generativelanguage.googleapis.com/';

/** The SDK's multi-regional Vertex locations: each has its own host. */
const VERTEX_MULTI_REGIONAL = new Set(['us', 'eu']);

/**
 * The Vertex AI host for a location, given explicitly in `httpOptions.baseUrl`
 * so the adapter takes its host from configuration, not from `GOOGLE_VERTEX_BASE_URL`
 * in the server's environment (left unset, `@google/genai` reads that variable).
 * Mirrors the SDK's own construction: `global` and the multi-regional locations
 * each get a dedicated host, every other location a regional one.
 */
export function vertexBaseUrl(location: string): string {
  if (location === 'global') return 'https://aiplatform.googleapis.com/';
  if (VERTEX_MULTI_REGIONAL.has(location)) {
    return `https://aiplatform.${location}.rep.googleapis.com/`;
  }
  return `https://${location}-aiplatform.googleapis.com/`;
}

/**
 * The SDK retries a call only when it's given `retryOptions`: three
 * attempts on a transient status (408, 429, 500, 502, 503, 504), backing
 * off from a second, with jitter, the OpenAI and Anthropic SDKs' default
 * count. Unlike theirs, it doesn't retry a failed connection (Node's
 * `fetch failed`).
 */
const RETRY_ATTEMPTS = 3;

/**
 * A Gemini `ModelProvider`, on Vertex AI (`vertex`) or the Gemini
 * Developer API (`apiKey`). Non-streaming, tool-use enabled: one
 * `generateContent` call per `invoke`.
 */
export function createGeminiProvider(options: GeminiProviderOptions): ModelProvider {
  const { metadata } = options;
  if (options.client === undefined) checkTarget(metadata.id, options);
  const modelsByName = new Map<string, GeminiModelInfo>(
    metadata.models.map((m) => [m.name, m] as const),
  );

  // One client per credential, reused while it resolves to that one: calls
  // whose keys take turns (a run in each of two projects with keys of their
  // own) each reuse their own; a rotated key builds a new one. On Vertex AI
  // a client holds its own auth client and the token it fetched, so a client
  // built again fetches a token again. `''` stands for ADC.
  const clients = createClientsByKey<GeminiClient>();
  // Counts each call's HTTP attempts, through the `fetch` the client sends with.
  const attempts = createAttemptCounter();
  async function resolveClient(): Promise<GeminiClient> {
    if (options.client !== undefined) return options.client;
    if (options.apiKey !== undefined) {
      const key = await options.apiKey();
      if (key.trim() === '') {
        throw new Error(
          `${GEMINI_ADAPTER_ID}: provider "${metadata.id}"'s Gemini API key is empty.`,
        );
      }
      // Checked before the SDK sends it: fetch's own error for a key it can't
      // send (a line break inside) quotes the key, into the call's failure.
      const problem = headerValueProblem(key);
      if (problem !== undefined) {
        throw new Error(
          `${GEMINI_ADAPTER_ID}: provider "${metadata.id}": its API key has ${problem}, which a header can't carry: store the secret without it`,
        );
      }
      return clients.get(
        key,
        () =>
          new GoogleGenAI({
            apiKey: key,
            // Given, so GOOGLE_GENAI_USE_VERTEXAI / _ENTERPRISE in the server's environment can't
            // move a Developer API provider to Vertex AI (the server's project and credentials).
            vertexai: false,
            httpOptions: {
              // Given, so GOOGLE_GEMINI_BASE_URL in the server's environment can't move the call.
              baseUrl: GEMINI_DEVELOPER_BASE_URL,
              fetch: attempts.fetch,
              retryOptions: { attempts: RETRY_ATTEMPTS },
            },
          }),
      );
    }
    const vertex = options.vertex as NonNullable<GeminiProviderOptions['vertex']>;
    const key = options.credentials !== undefined ? await options.credentials() : '';
    return clients.get(
      key,
      () =>
        new GoogleGenAI({
          vertexai: true,
          project: vertex.project,
          location: vertex.location,
          httpOptions: {
            // Given, so GOOGLE_VERTEX_BASE_URL in the server's environment can't move the call.
            baseUrl: vertexBaseUrl(vertex.location),
            fetch: attempts.fetch,
            retryOptions: { attempts: RETRY_ATTEMPTS },
          },
          ...(key !== '' && {
            googleAuthOptions: {
              credentials: parseServiceAccountKey(key),
              scopes: [CLOUD_PLATFORM_SCOPE],
            },
          }),
        }),
    );
  }

  return {
    metadata,
    async invoke(input: ModelCallInput): Promise<ModelCallResult> {
      const model = modelsByName.get(input.model);
      if (model === undefined) {
        throw new Error(
          `${GEMINI_ADAPTER_ID}: provider "${metadata.id}" does not expose model "${input.model}". ` +
            `Available: ${[...modelsByName.keys()].join(', ') || '<none>'}.`,
        );
      }
      const startedAt = Date.now();
      // Images and PDFs go to a model that declares `vision`; text files to any.
      const vision = model.features.includes('vision');
      const files = await fileParts(input.messages, {
        readFile: input.readFile,
        images: vision,
        documents: vision,
        contextWindow: model.contextWindow,
      });
      const { systemInstruction, contents } = toGeminiRequest(input.messages, files);
      const maxOutputTokens = input.maxOutputTokens ?? model.maxOutputTokens;
      const sampling = samplingFor(model, input);
      const thinking = thinkingLevelFor(input, model);
      const config: GenerateContentConfig = {
        ...(systemInstruction !== undefined && { systemInstruction }),
        ...(input.tools !== undefined &&
          input.tools.length > 0 && {
            tools: [{ functionDeclarations: [...toGeminiFunctions(input.tools)] }],
          }),
        ...(input.structuredOutput !== undefined && {
          responseMimeType: 'application/json',
          responseJsonSchema: input.structuredOutput.schema,
        }),
        ...(sampling.temperature !== undefined && { temperature: sampling.temperature }),
        ...(thinking.thinkingLevel !== undefined && {
          // Gemini's thinking levels: `minimal`, `low`, `medium`, `high` (3.8 Flash refuses `minimal`).
          thinkingConfig: { thinkingLevel: thinking.thinkingLevel as GeminiThinkingConfigLevel },
        }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
        // A header on this request only, when the caller sets it (the
        // provider's registration opted in); merged into the client's.
        ...(input.traceparent !== undefined && {
          httpOptions: { headers: { traceparent: input.traceparent } },
        }),
      };

      const client = await resolveClient();
      const counted = await attempts.count(() =>
        client.models.generateContent({
          model: input.model,
          contents: [...contents],
          config,
        }),
      );
      const response = counted.value;

      const { message, finishReason } = fromGeminiResponse(response);
      const usage = toFrameworkUsage(response.usageMetadata);
      const warnings = [...sampling.warnings, ...thinking.warnings];
      return {
        message,
        finishReason,
        usage,
        costUsd: computeCostUsd(usage, model.cost),
        durationMs: Date.now() - startedAt,
        provider: { id: metadata.id, model: input.model },
        ...(response.modelVersion !== undefined && { servedModel: response.modelVersion }),
        ...(response.responseId !== undefined && { providerRequestId: response.responseId }),
        // An injected client sends with its own fetch: nothing was counted.
        ...(counted.attempts > 0 && { attempts: counted.attempts }),
        ...(response.usageMetadata !== undefined && { rawUsage: { ...response.usageMetadata } }),
        ...(thinking.result !== undefined && { thinking: thinking.result }),
        ...(warnings.length > 0 && { warnings }),
      };
    },
  };
}

/**
 * A service-account key's JSON, reduced to the fields a service-account
 * key has. google-auth-library acts on a credential's `type`: an
 * `external_account` fetches URLs it names (with its headers) and reads
 * files it names, `token_uri` and `universe_domain` move the token
 * exchange. A tenant writes this secret, so only `service_account` is
 * accepted, and Google's own token endpoint is always used.
 */
export function parseServiceAccountKey(key: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new Error(`${GEMINI_ADAPTER_ID}: the credential isn't a service-account key (not JSON).`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: the credential isn't a service-account key (not an object).`,
    );
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.type !== 'service_account') {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: the credential must be a service-account key ("type": "service_account"); other credential types aren't accepted.`,
    );
  }
  if (typeof fields.client_email !== 'string' || typeof fields.private_key !== 'string') {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: the credential isn't a service-account key (no client_email / private_key).`,
    );
  }
  const reduced: Record<string, string> = {
    type: 'service_account',
    client_email: fields.client_email,
    private_key: fields.private_key,
  };
  for (const optional of ['project_id', 'private_key_id', 'client_id'] as const) {
    const value = fields[optional];
    if (typeof value === 'string') reduced[optional] = value;
  }
  return reduced;
}

/**
 * The adapter factory servers register under `GEMINI_ADAPTER_ID`. A
 * provider registered with it carries `adapter_config.api`: `vertex` (the
 * default) or `developer`.
 *
 * On Vertex AI (`api: "vertex"`, or none):
 *   - `adapter_config.project` — the Vertex AI project (required);
 *   - `metadata.region` — the Vertex location (`global`, `us-central1`,
 *     `northamerica-northeast1`, …); `'unspecified'` means `global`;
 *   - `secret_ref` (optional) — a service-account key. Without one the
 *     adapter uses Application Default Credentials, the server's own,
 *     unless the deployment refuses those to tenant configuration
 *     (`serverCredentials: false`, `KINDGI_TENANT_HOST_ACCESS=isolated`):
 *     then it's required.
 *
 * On the Gemini Developer API (`api: "developer"`):
 *   - `secret_ref` (required) — a Gemini API key from Google AI Studio.
 *
 * How much a model thinks is the call's level (an agent's model
 * settings), or the model's `metadata.models[].thinking.default` when it
 * asks none. `adapter_config.thinkingLevels`, which set it before, is no
 * longer read: a registration with it is refused, and a stored one builds
 * without it (`movedConfigKeys`).
 */
export const geminiAdapterFactory: AdapterFactory = (input) => {
  const metadata = input.metadata as GeminiProviderOptions['metadata'];
  const hasSecretRef = input.resolveApiKey !== undefined;
  throwIf(
    input.metadata.id,
    apiProblem(input) ??
      developerKeyProblem(input, hasSecretRef) ??
      serverCredentialsProblem(input, hasSecretRef),
  );
  if (apiOf(input) === 'developer') {
    return createGeminiProvider({
      metadata,
      apiKey: input.resolveApiKey as () => Promise<string>,
    });
  }
  return createGeminiProvider({
    metadata,
    vertex: vertexTarget(input),
    ...(input.resolveApiKey !== undefined && { credentials: input.resolveApiKey }),
  });
};

/**
 * What's wrong with a registration for this adapter, read without building
 * it (`AdapterFactoryEntry.checkConfig`): its API, its Gemini API key on
 * the Developer API, its Vertex project and location. Each problem's
 * message is the error the factory throws for it: both read the
 * registration through the same functions.
 */
export function geminiCheckConfig(input: AdapterConfigCheckInput): readonly AdapterConfigProblem[] {
  const api = apiProblem(input);
  if (api !== undefined) return [api];
  if (apiOf(input) === 'developer') {
    const key = developerKeyProblem(input, input.hasSecretRef);
    return key !== undefined ? [key] : [];
  }
  const server = serverCredentialsProblem(input, input.hasSecretRef);
  return [...vertexTargetProblems(input), ...(server !== undefined ? [server] : [])];
}

/** The entry a runtime registers: the factory, its static check, and the keys it takes. */
export const geminiAdapterEntry: AdapterFactoryEntry = {
  adapterId: GEMINI_ADAPTER_ID,
  capabilityKind: 'llm-inference',
  factory: geminiAdapterFactory,
  checkConfig: geminiCheckConfig,
  configKeys: ['api', 'project'],
  // How much a model thinks moved to the model's metadata in 0.3.0.
  movedConfigKeys: { thinkingLevels: 'metadata.models[].thinking.default' },
};

/** What the checks read of a registration. */
type Registration = Pick<AdapterFactoryInput, 'metadata' | 'config' | 'serverCredentials'>;

function throwIf(providerId: string, problem: AdapterConfigProblem | undefined): void {
  if (problem !== undefined) throw adapterConfigError(GEMINI_ADAPTER_ID, providerId, problem);
}

function apiOf(input: Registration): unknown {
  return input.config?.api ?? 'vertex';
}

function apiProblem(input: Registration): AdapterConfigProblem | undefined {
  const api = apiOf(input);
  if (api === 'vertex' || api === 'developer') return undefined;
  return {
    path: '/adapter_config/api',
    message: `adapter_config.api must be "vertex" or "developer", got ${JSON.stringify(api)}.`,
  };
}

function developerKeyProblem(
  input: Registration,
  hasSecretRef: boolean,
): AdapterConfigProblem | undefined {
  if (apiOf(input) !== 'developer' || hasSecretRef) return undefined;
  return {
    path: '/secret_ref',
    message:
      'uses the Gemini Developer API (adapter_config.api "developer") and needs secret_ref: its Gemini API key.',
  };
}

/** Vertex AI with no key signs in as the server: refused where the deployment says so. */
function serverCredentialsProblem(
  input: Registration,
  hasSecretRef: boolean,
): AdapterConfigProblem | undefined {
  if (apiOf(input) !== 'vertex' || hasSecretRef || input.serverCredentials !== false) {
    return undefined;
  }
  return {
    path: '/secret_ref',
    message:
      "uses Vertex AI without secret_ref, which signs in with the server's own Google credentials (Application Default Credentials); this deployment doesn't let tenant configuration use them (KINDGI_TENANT_HOST_ACCESS). Name a service-account key in secret_ref.",
  };
}

/** The Vertex project and location a registration names (see `geminiAdapterFactory`). */
export function vertexTarget(
  input: Parameters<AdapterFactory>[0],
): NonNullable<GeminiProviderOptions['vertex']> {
  throwIf(input.metadata.id, vertexTargetProblems(input)[0]);
  return {
    project: input.config?.project as string,
    location: locationOf(input),
  };
}

function locationOf(input: Registration): string {
  return input.metadata.region === 'unspecified' ? 'global' : input.metadata.region;
}

function vertexTargetProblems(input: Registration): AdapterConfigProblem[] {
  const project = input.config?.project;
  if (typeof project !== 'string' || project.length === 0) {
    return [
      {
        path: '/adapter_config/project',
        message: 'needs adapter_config.project (the Vertex AI project).',
      },
    ];
  }
  return vertexTargetProblemsOf({ project, location: locationOf(input) });
}

/** A provider names exactly one target: Vertex AI, or a Gemini API key. */
function checkTarget(providerId: string, options: GeminiProviderOptions): void {
  if ((options.vertex === undefined) === (options.apiKey === undefined)) {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: provider "${providerId}" needs exactly one of vertex (a Vertex AI project) or apiKey (a Gemini Developer API key).`,
    );
  }
  if (options.vertex !== undefined) throwIf(providerId, vertexTargetProblemsOf(options.vertex)[0]);
}

/**
 * The project goes in the request path and the location into the host that
 * `vertexBaseUrl` builds, so each is held to one safe shape before it reaches
 * a request URL: the project a Google Cloud project id or number, the location
 * a single DNS label.
 */
function vertexTargetProblemsOf(
  vertex: NonNullable<GeminiProviderOptions['vertex']>,
): AdapterConfigProblem[] {
  const problems: AdapterConfigProblem[] = [];
  if (!VERTEX_PROJECT.test(vertex.project)) {
    problems.push({
      path: '/adapter_config/project',
      message: 'adapter_config.project must be a Google Cloud project id or number.',
    });
  }
  if (!VERTEX_LOCATION.test(vertex.location)) {
    problems.push({
      path: '/metadata/region',
      message: 'metadata.region must be a Vertex AI location (one DNS label, e.g. us-central1).',
    });
  }
  return problems;
}

/** A Google Cloud project id (6–30: lowercase, digits, hyphens) or project number. */
const VERTEX_PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/;
/** A Vertex AI location: one DNS label. */
const VERTEX_LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
