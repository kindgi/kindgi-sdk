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
  /** The Vertex AI project and location (`global`, or a region such as `us-central1`). */
  readonly vertex: { readonly project: string; readonly location: string };
  /**
   * A service-account key (its JSON), resolved on every call. Absent:
   * Google Application Default Credentials — `gcloud auth
   * application-default login` on a laptop, the attached service account
   * on Cloud Run and other Google Cloud runtimes.
   */
  readonly credentials?: () => string | Promise<string>;
  /** An injected client, used as is (tests). `vertex` and `credentials` are then unused. */
  readonly client?: GeminiClient;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * A Gemini `ModelProvider` on Vertex AI. Non-streaming, tool-use enabled:
 * one `generateContent` call per `invoke`.
 */
export function createGeminiProvider(options: GeminiProviderOptions): ModelProvider {
  const { metadata } = options;
  checkVertexTarget(metadata.id, options.vertex);
  const modelsByName = new Map<string, GeminiModelInfo>(
    metadata.models.map((m) => [m.name, m] as const),
  );

  // One client per credential: reused while the resolved key stays the
  // same, rebuilt when it rotates. `''` stands for ADC.
  let cached: { readonly key: string; readonly client: GeminiClient } | undefined;
  async function resolveClient(): Promise<GeminiClient> {
    if (options.client !== undefined) return options.client;
    const key = options.credentials !== undefined ? await options.credentials() : '';
    if (cached?.key === key) return cached.client;
    const client = new GoogleGenAI({
      vertexai: true,
      project: options.vertex.project,
      location: options.vertex.location,
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
        ...(input.temperature !== undefined && { temperature: input.temperature }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(input.abortSignal !== undefined && { abortSignal: input.abortSignal }),
      };

      const client = await resolveClient();
      const response = await client.models.generateContent({
        model: input.model,
        contents: [...contents],
        config,
      });

      const { message, finishReason } = fromGeminiResponse(response);
      const usage = toFrameworkUsage(response.usageMetadata);
      return {
        message,
        finishReason,
        usage,
        costUsd: computeCostUsd(usage, model.cost),
        durationMs: Date.now() - startedAt,
        provider: { id: metadata.id, model: input.model },
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
 * provider registered with it carries:
 *
 *   - `adapter_config.project` — the Vertex AI project (required);
 *   - `metadata.region` — the Vertex location (`global`, `us-central1`,
 *     `northamerica-northeast1`, …); `'unspecified'` means `global`;
 *   - `secret_ref` (optional) — a service-account key. Without one the
 *     adapter uses Application Default Credentials.
 */
export const geminiAdapterFactory: AdapterFactory = (input) =>
  createGeminiProvider({
    metadata: input.metadata as GeminiProviderOptions['metadata'],
    vertex: vertexTarget(input),
    ...(input.resolveApiKey !== undefined && { credentials: input.resolveApiKey }),
  });

/** The Vertex project and location a registration names (see `geminiAdapterFactory`). */
export function vertexTarget(
  input: Parameters<AdapterFactory>[0],
): GeminiProviderOptions['vertex'] {
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

/**
 * The SDK puts the project in the request path and builds the hostname
 * from the location (`https://<location>-aiplatform.googleapis.com/`):
 * anything but a project id and one DNS label could move the request,
 * with the server's credentials, to another host.
 */
function checkVertexTarget(providerId: string, vertex: GeminiProviderOptions['vertex']): void {
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
