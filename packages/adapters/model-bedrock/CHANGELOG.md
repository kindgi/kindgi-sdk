# @kindgi/adapter-model-bedrock

## 0.2.0

### Patch Changes

- @kindgi/capabilities@0.2.0
  - @kindgi/adapter-model-shared@0.2.0
  - @kindgi/types@0.2.0

## 0.1.10

### Patch Changes

- @kindgi/capabilities@0.1.10
  - @kindgi/adapter-model-shared@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/adapter-model-shared@0.1.10-rc.1
  - @kindgi/capabilities@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.0
  - @kindgi/adapter-model-shared@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9
  - @kindgi/adapter-model-shared@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/adapter-model-shared@0.1.9-rc.1
  - @kindgi/capabilities@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9-rc.0
  - @kindgi/adapter-model-shared@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- ebf405d: **`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
  - **`@kindgi/api`:**
    - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
    - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local and site-local) and `'server-credentials'` (signing in as the server: with credentials its environment holds, or as its own cloud identities). Only `isolated` denies them.
    - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
  - **`@kindgi/capabilities`:**
    - `AdapterFactoryInput.serverCredentials?` and `AdapterConfigCheckInput.serverCredentials?` (optional) say whether a registration may sign in as the server. Absent means allowed, as before.
    - `createAdapterFactoryRegistry(seed, { serverCredentials: false })` tells every factory and every `checkConfig`, and withholds the runtime's `identities` from them, so each check learns there are none. An input can't turn either back on.
  - **The adapters, with `serverCredentials: false`:** each refuses the registration in its check and its factory, with the same message, naming the alternative:
    - `@kindgi/adapter-model-gemini`: Vertex AI without `secret_ref`, which would sign in with Application Default Credentials;
    - `@kindgi/adapter-model-bedrock`: `auth: aws-identity`, the default (use `api-key`);
    - `@kindgi/adapter-model-azure-openai`: `auth: entra` (use the resource's API key).
  
    A registration with its own key is unchanged.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`; those descriptions, and `KINDGI_AWS_IDENTITY`'s, say so.
  - **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
- Updated dependencies [63a06d6]
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/adapter-model-shared@0.1.8
  - @kindgi/capabilities@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- ebf405d: **`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
  - **`@kindgi/api`:**
    - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
    - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local and site-local) and `'server-credentials'` (signing in as the server: with credentials its environment holds, or as its own cloud identities). Only `isolated` denies them.
    - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
  - **`@kindgi/capabilities`:**
    - `AdapterFactoryInput.serverCredentials?` and `AdapterConfigCheckInput.serverCredentials?` (optional) say whether a registration may sign in as the server. Absent means allowed, as before.
    - `createAdapterFactoryRegistry(seed, { serverCredentials: false })` tells every factory and every `checkConfig`, and withholds the runtime's `identities` from them, so each check learns there are none. An input can't turn either back on.
  - **The adapters, with `serverCredentials: false`:** each refuses the registration in its check and its factory, with the same message, naming the alternative:
    - `@kindgi/adapter-model-gemini`: Vertex AI without `secret_ref`, which would sign in with Application Default Credentials;
    - `@kindgi/adapter-model-bedrock`: `auth: aws-identity`, the default (use `api-key`);
    - `@kindgi/adapter-model-azure-openai`: `auth: entra` (use the resource's API key).
  
    A registration with its own key is unchanged.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`; those descriptions, and `KINDGI_AWS_IDENTITY`'s, say so.
  - **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
- Updated dependencies [63a06d6]
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/adapter-model-shared@0.1.8-rc.0
  - @kindgi/capabilities@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- 7bd61d6: **New package: `@kindgi/adapter-model-bedrock`,** Amazon Bedrock as a model provider: Claude, Nova, Llama, Mistral, OpenAI's models and the others Bedrock serves, on its Converse API. It's built on `@kindgi/adapter-model-shared`.
  - **A registration** names its AWS region (`metadata.region`, required) and its models by Bedrock model or inference-profile id (`us.amazon.nova-pro-v1:0`). `adapter_config.baseURL` is optional, for a VPC or FIPS endpoint. Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
  - **It signs in two ways, before each attempt:**
    - `auth: aws-identity` (default): the runtime's own AWS identity, SigV4 with credentials asked for every attempt, sent only to Bedrock's runtime in the region (a registration naming another host is refused);
    - `auth: api-key`: a Bedrock API key through `secret_ref`, read for every attempt. A key a header can't carry (a line break or a control character inside it) is refused as `auth` before the request, by its `secret_ref`, never quoted.
    A failed sign-in (no credentials, no key, a blank one) is an `auth` error, never retried, and a 403 says what to check for the way it signed in. No request follows a redirect. It never reads AWS credentials, a bearer token, the region or an endpoint from the environment.
- 7bd61d6: **The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
  - `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
- Updated dependencies [7bd61d6]
- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/adapter-model-shared@0.1.7
  - @kindgi/capabilities@0.1.7
  - @kindgi/types@0.1.7

## 0.1.7-rc.0

### Patch Changes

- 7bd61d6: **New package: `@kindgi/adapter-model-bedrock`,** Amazon Bedrock as a model provider: Claude, Nova, Llama, Mistral, OpenAI's models and the others Bedrock serves, on its Converse API. It's built on `@kindgi/adapter-model-shared`.
  - **A registration** names its AWS region (`metadata.region`, required) and its models by Bedrock model or inference-profile id (`us.amazon.nova-pro-v1:0`). `adapter_config.baseURL` is optional, for a VPC or FIPS endpoint. Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
  - **It signs in two ways, before each attempt:**
    - `auth: aws-identity` (default): the runtime's own AWS identity, SigV4 with credentials asked for every attempt, sent only to Bedrock's runtime in the region (a registration naming another host is refused);
    - `auth: api-key`: a Bedrock API key through `secret_ref`, read for every attempt. A key a header can't carry (a line break or a control character inside it) is refused as `auth` before the request, by its `secret_ref`, never quoted.
    A failed sign-in (no credentials, no key, a blank one) is an `auth` error, never retried, and a 403 says what to check for the way it signed in. No request follows a redirect. It never reads AWS credentials, a bearer token, the region or an endpoint from the environment.
- 7bd61d6: **The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
  - `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
- Updated dependencies [7bd61d6]
- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/adapter-model-shared@0.1.7-rc.0
  - @kindgi/capabilities@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0
