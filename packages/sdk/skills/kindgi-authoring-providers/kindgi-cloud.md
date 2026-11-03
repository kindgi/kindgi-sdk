# On Kindgi Cloud: the key and its provider go under `prod`

A pack deployed with `kindgi deploy --hosted` runs on your workspace's
runtime on Kindgi Cloud, and that runtime serves the `prod` environment,
before and after you go live. The other files' examples use `--env=local`, for
`kindgi dev`. For Kindgi Cloud, name `prod` instead:

```sh
kindgi secrets set ANTHROPIC_API_KEY --env=prod --scope=tenant   # a no-echo prompt
kindgi providers register --preset=anthropic --env=prod
kindgi deploy --hosted --env=prod
```

- The runtime reads a provider's key in the environment its
  `secret_ref.envName` names, at tenant scope. Keep the key and the
  provider both on `prod`. A provider registered without `--env` reads
  `local`, not the `prod` key: `register` refuses when the pack's own env
  files lack the key (its message names `--env`), and otherwise the first
  turn can't find the key (mistake 1 in `common-mistakes.md`). By hand, `provider.json` has
  `"secret_ref": { "envName": "prod", … }`.
- `kindgi secrets set` has no default environment: name `--env` every time.
- The deployment `kindgi deploy` sends names no environment. Its
  `--env=prod` picks the pack's own `prod` settings, such as its signing
  key.
- `kindgi deploy` doesn't register providers, and the providers declared in
  the pack's config are `kindgi dev`'s only. Register once on `prod`, by
  hand, and again when you add a provider or change one.
- OpenAI, the Gemini API, Groq and OpenRouter take the same two lines,
  with their preset and key: `openai` and `OPENAI_API_KEY`, `gemini-api`
  and `GEMINI_API_KEY`, `groq` and `GROQ_API_KEY`, `openrouter` and
  `OPENROUTER_API_KEY`. Bedrock, Vertex AI and Azure OpenAI don't fit
  them: see `bedrock.md` and `path-d-vertex.md`, and `kindgi providers
  presets` for `azure-openai`'s settings.

The whole flow, from signing the CLI in to going live:
https://docs.kindgi.com/v0.3/hosted/deploy-your-agent/#your-model-key-and-its-provider
