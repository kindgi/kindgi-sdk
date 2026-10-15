---
"@kindgi/cli": patch
---

**`kindgi build --hosted` and `kindgi deploy --hosted`: build and deploy on Kindgi hosted.**
- **`kindgi build --hosted`,** or the env block's `build: 'hosted'`, builds on the hosted build service, at the API's address under `/cloud`.
  - It sends the CLI's API key, and only there: a self-hosted build server never receives a key.
  - It sends the pack's id, and with `--project <id>`, the project as a label on the build.
  - The image goes to your workspace's own repository, so it's checked by its index's hash, not pulled.
  - With no tenant set, the signature names the key's own tenant.
  - The API's address is `--url`, else the env block's `endpoint`, else `KINDGI_API_URL` or `kindgi auth login`'s.
  - `--local`, `--endpoint` and `--registry-push-creds` don't go with it.
  - A pack over 30 MiB packed isn't sent; the message links what the pack's image needs.
- **A build service's refusals** (`{ error: { code, message } }`) print plainly, with their code and the wait they ask. A `429` with `Retry-After` is waited out, and the same build sent again.
- **The build's log stream,** cut before its end, is opened again (any build server): the lines it replays are printed once. It waits a `Retry-After`, stops at once on `401`, `403`, `404` or `410`, and gives up after five openings in a row that bring nothing new.
- **`kindgi deploy --hosted`** runs a missing inline build hosted. After the deploy, it waits up to 5 minutes for the deployment's pack service to be ready, saying each new state once (`pending`, and why), and fails when it's cleared. `--from-envelope` deploys an envelope built earlier, with no build. `--build-endpoint` doesn't go with it.
- **`kindgi deploy --project`** is resolved before an inline build, so a project that isn't there fails before anything is built.
