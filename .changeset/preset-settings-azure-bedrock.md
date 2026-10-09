---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

**Two presets: `azure-openai` and `bedrock`.** They need a runtime with the Azure OpenAI and Bedrock adapters.
- **`azure-openai`:** GPT-6.1 Sol and GPT-6 Luna on your Azure OpenAI deployments, with the key `AZURE_OPENAI_API_KEY`: `kindgi providers register --preset=azure-openai --resource-name=<resource> --deployments=gpt-6.1-sol=<deployment>,…`. To sign in as the runtime's Entra identity instead, register with a spec.
- **`bedrock`:** Claude Sonnet 5.5, Nova Pro, GPT-6.1 Sol and GPT-6 Luna on Amazon Bedrock, through their US cross-region inference profiles, as the runtime's AWS identity: `kindgi providers register --preset=bedrock --region=<a US region>`.
- **Their prices** are the vendors' list prices, checked 2026-10-09: Azure's Global Standard, and Bedrock's on-demand US profiles.

**A preset's settings are one table.** The `providers register` flags (`--project`, `--resource-name`, `--deployments`, `--region`), a pack's `providers` declarations (`project`, `resourceName`, `deployments`, `region`, also new on `KindgiProviderDeclaration`), `kindgi providers presets` and doctor's hints all read it. A preset that names a setting the table doesn't have fails to load. Doctor's register hint names a keyed preset's settings (`azure-openai (with --resource-name=<resourceName> --deployments=<deployments>)`).
