---
"@kindgi/cli": patch
---

**`kindgi deploy` and `kindgi build --hosted` send a stored API key only to the address stored with it.** A stored key is the one `kindgi auth login` keeps in `~/.kindgi/config.json`, or `kindgi dev` in the folder's `.kindgirc.json`, beside the address it's for.
- **A change to a released command:** `kindgi deploy` with a stored key is now refused when the deploy would go to another address than the one stored with the key. That holds wherever the other address is named: `--endpoint`, the env block's `endpoint`, `--url`, `KINDGI_API_URL`, or a folder's `.kindgirc.json`. Before, the deploy went there with the stored key. The refusal names both addresses and the file the key is in. To deploy there, use one of these fixes:
  - give that server's own key with `--token` or an exported `KINDGI_API_TOKEN`;
  - point the address at the one stored with the key;
  - or, for a key from `kindgi auth login`, sign in to the other address with `kindgi auth login --url <url>`.
  A key given with `--token` or `KINDGI_API_TOKEN` goes where the command says, as before. A stored key with no address stored beside it (only a hand-written file has one) is now refused too.
- **`--hosted` (or `build: 'hosted'`) always goes to the CLI's own API address:** `--url`, `KINDGI_API_URL`, or the stored one, and a stored key only when that's its own address. An env block's `endpoint` or `--endpoint` may only repeat that address. Another address is refused, naming both, whichever key is used. Before, an env block's `endpoint` won over the address you signed in to. With no API address set, the hosted command stops and says how to set one.
- **In a folder where `kindgi dev` ran, `--hosted` goes to the address you signed in to, with that key.** It doesn't read the folder's `.kindgirc.json` when that file points at a local runtime (`localhost`, `127.0.0.1` or `[::1]`): neither its address nor its key. A `.kindgirc.json` at any other address is read as before.
- **How addresses are compared:** after normalizing the URL. The host's case doesn't matter. A scheme's default port (`:443`, `:80`) and a trailing `/` are left out. `localhost`, `127.0.0.1` and `[::1]` are one address.
- **A build that signs checks its key before building anything.** It refuses a key file that's missing or isn't a file, naming the path and where it was set (`--signing-key` or `environments.<env>.signingKey`). It also refuses no key at all. The refusals say how to make a key and have it trusted: `kindgi key create <id>`, then `kindgi key trust <id>`. Then they say where the key goes: the env block picked with `--env`, or `--signing-key`.
- **`kindgi init`'s TypeScript templates leave `environments` empty:** a commented Kindgi Cloud block (`build: 'hosted'` and a `signingKey`) and a commented block for a runtime of your own. Before, a new pack carried placeholder blocks that a deploy would use. The Python template's commented example follows the same shape.
- **`kindgi deploy --project <slug>` with no such project** now points only to `kindgi projects list`. It no longer names a command that doesn't exist.
