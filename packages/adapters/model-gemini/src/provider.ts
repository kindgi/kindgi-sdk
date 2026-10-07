// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import type {
  AdapterFactory,
  ModelCallInput,
  ModelCallResult,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';
import { samplingFor } from '@kindgi/capabilities';
import { createAttemptCounter } from '@kindgi/capabilities/attempts';

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

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

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

  // One client per credential: reused while the resolved key stays the
  // same, rebuilt when it rotates. `''` stands for ADC.
  let cached: { readonly key: string; readonly client: GeminiClient } | undefined;
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
      if (cached?.key === key) return cached.client;
      const client = new GoogleGenAI({ apiKey: key, httpOptions: { fetch: attempts.fetch } });
      cached = { key, client };
      return client;
    }
    const vertex = options.vertex as NonNullable<GeminiProviderOptions['vertex']>;
    const key = options.credentials !== undefined ? await options.credentials() : '';
    if (cached?.key === key) return cached.client;
    const client = new GoogleGenAI({
      vertexai: true,
      project: vertex.project,
      location: vertex.location,
      httpOptions: { fetch: attempts.fetch },
      ...(key !== '' && {
        googleAuthOptions: {
          credentials: parseServiceAccountKey(key),
          scopes: [CLOUD_PLATFORM_SCOPE],
        },
      }),
    });
    cached = { key, client };
    return client;
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
      const { systemInstruction, contents } = toGeminiRequest(input.messages);
      const maxOutputTokens = input.maxOutputTokens ?? model.maxOutputTokens;
      const sampling = samplingFor(model, input);
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
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
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
        ...(sampling.warnings.length > 0 && { warnings: sampling.warnings }),
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
 *     adapter uses Application Default Credentials.
 *
 * On the Gemini Developer API (`api: "developer"`):
 *   - `secret_ref` (required) — a Gemini API key from Google AI Studio.
 */
export const geminiAdapterFactory: AdapterFactory = (input) => {
  const metadata = input.metadata as GeminiProviderOptions['metadata'];
  const api = input.config?.api ?? 'vertex';
  if (api === 'developer') {
    if (input.resolveApiKey === undefined) {
      throw new Error(
        `${GEMINI_ADAPTER_ID}: provider "${input.metadata.id}" uses the Gemini Developer API (adapter_config.api "developer") and needs secret_ref: its Gemini API key.`,
      );
    }
    return createGeminiProvider({ metadata, apiKey: input.resolveApiKey });
  }
  if (api !== 'vertex') {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: provider "${input.metadata.id}" adapter_config.api must be "vertex" or "developer", got ${JSON.stringify(api)}.`,
    );
  }
  return createGeminiProvider({
    metadata,
    vertex: vertexTarget(input),
    ...(input.resolveApiKey !== undefined && { credentials: input.resolveApiKey }),
  });
};

/** The Vertex project and location a registration names (see `geminiAdapterFactory`). */
export function vertexTarget(
  input: Parameters<AdapterFactory>[0],
): NonNullable<GeminiProviderOptions['vertex']> {
  const project = input.config?.project;
  if (typeof project !== 'string' || project.length === 0) {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: provider "${input.metadata.id}" needs adapter_config.project (the Vertex AI project).`,
    );
  }
  const target = {
    project,
    location: input.metadata.region === 'unspecified' ? 'global' : input.metadata.region,
  };
  checkVertexTarget(input.metadata.id, target);
  return target;
}

/** A provider names exactly one target: Vertex AI, or a Gemini API key. */
function checkTarget(providerId: string, options: GeminiProviderOptions): void {
  if ((options.vertex === undefined) === (options.apiKey === undefined)) {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: provider "${providerId}" needs exactly one of vertex (a Vertex AI project) or apiKey (a Gemini Developer API key).`,
    );
  }
  if (options.vertex !== undefined) checkVertexTarget(providerId, options.vertex);
}

/**
 * The SDK puts the project in the request path and builds the hostname
 * from the location (`https://<location>-aiplatform.googleapis.com/`):
 * anything but a project id and one DNS label could move the request,
 * with the server's credentials, to another host.
 */
function checkVertexTarget(
  providerId: string,
  vertex: NonNullable<GeminiProviderOptions['vertex']>,
): void {
  if (!VERTEX_PROJECT.test(vertex.project)) {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: provider "${providerId}" adapter_config.project must be a Google Cloud project id or number.`,
    );
  }
  if (!VERTEX_LOCATION.test(vertex.location)) {
    throw new Error(
      `${GEMINI_ADAPTER_ID}: provider "${providerId}" metadata.region must be a Vertex AI location (one DNS label, e.g. us-central1).`,
    );
  }
}

/** A Google Cloud project id (6–30: lowercase, digits, hyphens) or project number. */
const VERTEX_PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/;
/** A Vertex AI location: one DNS label. */
const VERTEX_LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
