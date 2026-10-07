# @kindgi/dev-echo-provider

Deterministic `ModelProvider` for dev, tutorials, and tests. No LLM
key, no network, no cost. Every real deployment plugs in
`@kindgi/adapter-model-anthropic` (or an equivalent adapter) instead.

## Shape

Emits a two-message script (tool-call → text):

1. **First invocation** (no tool result yet) — asks the runtime to call
   the first tool in `input.tools` with `{ message: <last user message> }`,
   or `demo.echo` when the call declares no tools.
2. **Second invocation** (post-tool) — emits a final assistant message:
   `Tool responded: <tool result>`.

**It says it isn't a model.** Every text answer starts with one line,
`DEV_ECHO_WARNING_LINE`:

```text
⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, OpenRouter…) to get real answers.
```

An answer that is JSON (what a typed-output agent parses; dev-echo hands
back the JSON it was given) stays bare, as does one asked for with
`structuredOutput`. Every result also carries `warnings: [DEV_ECHO_WARNING]`
(code `dev-echo-not-a-model`, with the commands that add a model), which an
agent turn collects into its result's `warnings`.

State lives in the message trail, not on the instance — safe to share
across concurrent runs.

## Usage

```ts
import { createDevEchoProvider } from '@kindgi/dev-echo-provider';
import { createProviderRegistry } from '@kindgi/capabilities';

const provider = createDevEchoProvider();
// Registry is tenant-scoped — register the provider for each tenant
// that should have it available.
const { registry } = createProviderRegistry([
  { tenantId, provider },
]);
```

The provider id is `DEV_ECHO_PROVIDER_ID` (`'dev-echo'`) and its single
model is `DEV_ECHO_MODEL_NAME` (`'dev-echo-v1'`); `DEV_ECHO_PROVIDER_METADATA`
exposes the metadata without creating a provider.

## Not for production

The provider's metadata says so explicitly — `metadata.description` is
`'Dev-only deterministic provider — no LLM, canned scripted responses. NEVER for production.'`

If you find yourself reaching for this in a real deployment, wire a
real provider (`@kindgi/adapter-model-anthropic`,
`@kindgi/adapter-model-openai-compat`, etc.) instead.
