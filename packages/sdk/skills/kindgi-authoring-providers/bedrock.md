# Amazon Bedrock

Nova, Claude and GPT on Amazon Bedrock. The `bedrock` preset signs in as the
runtime's own AWS identity (`KINDGI_AWS_IDENTITY` says where it comes from),
so it takes no key:
```sh
kindgi providers register --preset=bedrock --region=us-east-2
kindgi providers register --preset=bedrock --region=us-east-2 \
  --models=us.anthropic.claude-haiku-4-5-20251001-v1:0   # Claude, not Nova Pro
```
`--region` is the US Region the account uses Bedrock in: the preset's models
are US cross-region inference profiles. Its default model is Amazon Nova Pro
(`us.amazon.nova-pro-v1:0`). Claude and GPT also need the AWS account's
access to their vendor's models
(https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

**On a runtime with `KINDGI_TENANT_HOST_ACCESS=isolated`, use a Bedrock API
key.** That runtime doesn't lend its own credentials to tenant configuration,
so it refuses the preset at registration and stores nothing:
```text
  ✗ /adapter_config/auth: adapter_config.auth = aws-identity (the default) signs in as the runtime's own AWS identity, which this deployment doesn't let tenant configuration use (KINDGI_TENANT_HOST_ACCESS). Set auth = api-key, with secret_ref naming a Bedrock API key.
```
`--secret` doesn't change that: the preset still signs in as the runtime.
Register from a spec whose `adapter_config.auth` is `api-key` and whose
`secret_ref` names the key:

1. **A long-term Bedrock API key**, made in the Region the provider uses. A
   short-term key lasts 12 hours at most, so a registration can't keep one,
   and a key works only in the Region it was made in. AWS recommends
   long-term keys for exploration only: tell the person so, with AWS's page
   (https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).
2. **Stored as a tenant secret**, with the no-echo prompt:
   `kindgi secrets set BEDROCK_API_KEY --env=production --scope=tenant`.
3. **Registered:** `kindgi providers register --spec=@bedrock.json`, with
   ```json
   {
     "adapter_id": "@kindgi/adapter-model-bedrock",
     "adapter_config": { "auth": "api-key" },
     "secret_ref": { "envName": "production", "name": "BEDROCK_API_KEY" },
     "metadata": {
       "id": "bedrock",
       "region": "us-east-2",
       "models": [
         { "name": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "contextWindow": 200000,
           "maxOutputTokens": 16000, "features": ["tool-use", "parallel-tool-use"],
           "cost": { "promptUsdPer1kTokens": 0.0011, "completionUsdPer1kTokens": 0.0055 } }
       ]
     }
   }
   ```

One provider is one Region and one key: another Region is another provider,
with a key made there. The key is read when a turn calls the model, not at
registration.

The same holds for the other providers that can sign in as the runtime on
`isolated`. Gemini on Vertex AI takes a service-account key in `secret_ref`
(Path D). Azure OpenAI's `auth: entra` is refused: use the `azure-openai`
preset, with the resource's key. A provider registered before the runtime
moved to `isolated` that signs in as the runtime isn't used there: a turn
that needs it fails with `422 capability-routing-failed`. Unregister it, and
register it again with a key.

Docs: https://docs.kindgi.com/v0.2/guides/models/#with-a-bedrock-api-key
