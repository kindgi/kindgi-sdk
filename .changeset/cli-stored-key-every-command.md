---
"@kindgi/cli": patch
---

**Every command sends a stored API key only to the address stored with it.** A stored key is the one `kindgi auth login` keeps in `~/.kindgi/config.json`, or `kindgi dev` in the folder's `.kindgirc.json`, beside the address it's for. Until now only `kindgi deploy` and `kindgi build --hosted` checked this. Every other command sent the stored key to whichever address it resolved: `--url`, `KINDGI_API_URL`, or a folder's `.kindgirc.json` that holds only an `apiUrl`. A cloned repository's file was enough to send it elsewhere.
- **The key is found by its address.** When the two files hold keys for different addresses, the key used is the one stored with the address the command goes to. In a folder where `kindgi dev` ran, `--url <the address you signed in to>` now uses your sign-in's key. Before, it sent the folder's `kindgi dev` key there. A `kindgi deploy` endpoint works the same way.
- **When no key is stored for the address, a command that needs the key is refused before it sends anything.** The refusal names both addresses and the file the key is in. When the other file holds a key too, it says which address that one is for. The fixes:
  - point the address back at the key's own;
  - sign in to the other address with `kindgi auth login --url <url> --token <its key>`;
  - or give that server's key for the command with `--token` or `KINDGI_API_TOKEN`.
  A command that sends no key, such as `kindgi health`, isn't refused.
- **A key given with `--token` or `KINDGI_API_TOKEN` goes where the command says, as before.** CI that passes both the address and the key isn't affected.
- **`kindgi auth login --url <url>` with no key given no longer saves the stored key under another address.** Before, it saved the key for one address as the other's, and every later command sent it there. To sign in somewhere else, give that server's key with `--token` or `KINDGI_API_TOKEN`. Running it again at the key's own address, with no key given, still works.
- **`kindgi doctor` has an `api-key` check.** It passes when the key is given for the command, or is stored for the address the CLI uses. It fails, with the fixes, when the stored key is for another address. When it fails, `console-sign-in` and `mcp-headers` skip rather than send the key.
- **Setups that now need a step:**
  - **Another name for the same server**, such as an internal hostname, an IP address or a proxy's path, used with a key you signed in with under the first name. Run `kindgi auth login --url <that name> --token <the key>` once, or pass `--token`.
  - **A hand-written config file that holds a `token` with no `apiUrl` beside it**, used with an address from anywhere else. Add `"apiUrl": "<url>"` beside the key, or sign in with `kindgi auth login --url <url> --token <the key>`. `kindgi auth login` has always written both.
