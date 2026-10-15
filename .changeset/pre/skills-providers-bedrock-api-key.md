---
"@kindgi/sdk": patch
---

**The providers skill covers Amazon Bedrock, and a Bedrock API key on a runtime that keeps tenants apart.** It registers the `bedrock` preset, which signs in as the runtime's AWS identity. On a runtime with `KINDGI_TENANT_HOST_ACCESS=isolated`, which refuses that, it registers Bedrock from a spec with `adapter_config.auth` set to `api-key` and `secret_ref` naming a long-term Bedrock API key. One key works in one Region, and the skill tells the person that AWS recommends long-term keys for exploration only, with AWS's page. It also names the same rule for Gemini on Vertex AI and Azure OpenAI, and lists the Azure OpenAI and Bedrock adapters among the model adapters.
