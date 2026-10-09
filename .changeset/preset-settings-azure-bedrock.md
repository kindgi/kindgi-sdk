---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

**Two presets: `azure-openai` and `bedrock`.** They need a runtime with the Azure OpenAI and Bedrock adapters.
- **`azure-openai`:** GPT-6.1 Sol and GPT-6 Luna on your Azure OpenAI deployments, with the key `AZURE_OPENAI_API_KEY`: `kindgi providers register --preset=azure-openai --resource-name=<resource> --deployments=gpt-6.1-sol=<deployment>,…`. To sign in as the runtime's Entra identity instead, register with a spec.
- **`bedrock`:** Claude Sonnet 5.5, Nova Pro, GPT-6.1 Sol and GPT-6 Luna on Amazon Bedrock, through their US cross-region inference profiles, as the runtime's AWS identity: `kindgi providers register --preset=bedrock --region=<a US region>`.
- **Their prices** are the vendors' list prices, checked 2026-10-09: Azure's Global Standard, and Bedrock's on-demand US profiles.

**A preset's settings are one table.** The `providers register` flags (`--project`, `--resource-name`, `--deployments`, `--region`), a pack's `providers` declarations (`project`, `resourceName`, `deployments`, `region`), `kindgi providers presets` and doctor's hints all read it. A preset that names a setting the table doesn't have fails to load. Doctor's register hint names a keyed preset's settings (`azure-openai (with --resource-name=<resourceName> --deployments=<deployments>)`).

**A preset declaration is typed by its preset.** `KindgiPresetDeclaration` (in `KindgiProviderDeclaration`) is a union on `preset`, built from `PRESET_DECLARATION_SETTINGS` (`@kindgi/handler-runtime`, new):
- a preset's own settings are required: `{ preset: 'bedrock', region: 'us-east-2' }`, `{ preset: 'gemini', project: 'acme-gcp' }`;
- another preset's are refused, by the type and by `kindgi dev`, which names whose setting it is;
- `deployments` is a map, model to deployment: `{ preset: 'azure-openai', resourceName: 'acme-openai', deployments: { 'gpt-6.1-sol': 'gpt-6-1-sol' } }`, a table in `pyproject.toml`. The `--deployments` flag keeps `model=deployment,…`, which is also what the runtime receives. An empty map is refused, and so is a name holding `,` or `=`.
Also new: `KindgiPresetName`, `KindgiPresetChoices` and `KindgiPresetSettingValues`. A preset whose region comes from `--region` (`bedrock`) carries none of its own.
