---
"@kindgi/adapter-model-bedrock": patch
---

**New package: `@kindgi/adapter-model-bedrock`,** Amazon Bedrock as a model provider: Claude, Nova, Llama, Mistral, OpenAI's models and the others Bedrock serves, on its Converse API. It's built on `@kindgi/adapter-model-shared`.
- **A registration** names its AWS region (`metadata.region`, required) and its models by Bedrock model or inference-profile id (`us.amazon.nova-pro-v1:0`). `adapter_config.baseURL` is optional, for a VPC or FIPS endpoint. Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
- **It signs in two ways, before each attempt:**
  - `auth: aws-identity` (default): the runtime's own AWS identity, SigV4 with credentials asked for every attempt, sent only to Bedrock's runtime in the region (a registration naming another host is refused);
  - `auth: api-key`: a Bedrock API key through `secret_ref`, read for every attempt.
  A failed sign-in (no credentials, no key, a blank one) is an `auth` error, never retried, and a 403 says what to check for the way it signed in. No request follows a redirect. It never reads AWS credentials, a bearer token, the region or an endpoint from the environment.
