---
"@kindgi/adapter-model-anthropic": patch
---

**A provider on the Anthropic adapter can send its calls through a gateway or a proxy: `adapter_config.baseURL`.** A registration with `"adapter_config": { "baseURL": "https://…" }` sends each call there instead of to Anthropic's API, with the key its `secret_ref` names, in `x-api-key`; the adapter adds the API's path, `/v1/messages`. The URL must be https, or http on this machine (localhost, 127.0.0.1, [::1], host.docker.internal, host.containers.internal) for a gateway run locally, with no credentials, query or fragment: the check run when a provider registers refuses any other, and so does the factory. `baseURL` is the adapter's only `adapter_config` key: a registration with any other is still refused, naming it.
