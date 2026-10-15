---
"@kindgi/cli": patch
---

**`kindgi deploy` and `kindgi build --hosted` send your API key only to the address it's for.**
- **A change to a released command:** `kindgi deploy` with the key stored by `kindgi auth login` (or by `kindgi dev` in `.kindgirc.json`) is now refused when `--endpoint` or the env block's `endpoint` names another address than the stored one. Before, the deploy went there with the stored key. The refusal names both addresses. To deploy there, use either fix:
  - give that server's own key with `--token` or an exported `KINDGI_API_TOKEN`;
  - or point `--endpoint` / `endpoint` at the stored address.
  A key given with `--token` or `KINDGI_API_TOKEN` goes where the command says, as before. A stored key with no stored address also goes where the command says, as before.
- **`--hosted` (or `build: 'hosted'`) always goes to the CLI's own API address:** `--url`, `KINDGI_API_URL`, or the stored one. An env block's `endpoint` or `--endpoint` may only repeat that address. Another address is refused, naming both, whichever key is used. Before, an env block's `endpoint` won over the address you signed in to. With no API address set, the hosted command stops and says how to set one.
- **How addresses are compared:** after normalizing the URL. The host's case doesn't matter. A scheme's default port (`:443`, `:80`) and a trailing `/` are left out. `localhost`, `127.0.0.1` and `[::1]` are one address.
- **A build that signs checks its key before building anything.** A missing key file is refused, naming the path and where it was set (`--signing-key` or `environments.<env>.signingKey`), and so is no key at all. Both refusals say how to make a key and have it trusted: `kindgi key create <id>`, then `kindgi key trust <id>`.
- **`kindgi init`'s TypeScript templates leave `environments` empty:** a commented Kindgi Cloud block (`build: 'hosted'` and a `signingKey`) and a commented block for a runtime of your own. Before, a new pack carried placeholder blocks that a deploy would use. The Python template's commented example follows the same shape.
- **`kindgi deploy --project <slug>` with no such project** now points only to `kindgi projects list`. It no longer names a command that doesn't exist.
