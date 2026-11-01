---
"@kindgi/cli": patch
---

`kindgi deploy` builds again when the pack changed since the envelope on disk was built, where it used to send that envelope as long as there was one. `kindgi build` now writes `build-inputs.json` beside `deploy-envelope.json`: the CLI's version, the options the envelope depends on, and the sha256 of each file the image was made from. A deploy runs `kindgi build` inline when any of them differs now, and names what changed: `` (`tools/lookup/index.ts` is new, and 1 more) ``.

- **Another `--env` or `--target` builds too:** an envelope built for staging is rebuilt for a deploy to prod. `kindgi promote` is what carries one build across environments. A CLI upgrade builds too: the next deploy builds with the new CLI.
- **An envelope with no `build-inputs.json` from its build**, as an earlier CLI wrote it, is sent as before, and the deploy says it can't tell whether the pack changed since.
- **A `--tenant`, a `--signer-key-id`, a pinned `--artifact-version` or `--published-at`, and `--skip-sign`** count only when the deploy has its own: its flag, or for a tenant or a key id its env block, and for a tenant `KINDGI_TENANT_ID`. A plain `kindgi deploy` with none sends the envelope a build made with them, and one with another builds again.
- **`--from-envelope`** still sends its file as it is, and warns when it doesn't match the deploy.
- **What it can't see:** a file the build didn't read, which would change how an unchanged import resolves now, such as a new `lib/greet.ts` beside the `lib/greet/index.ts` an import found before. `kindgi build` before the deploy covers that.
