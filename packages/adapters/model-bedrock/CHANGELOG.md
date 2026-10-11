# @kindgi/adapter-model-bedrock

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
