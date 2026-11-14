---
"@kindgi/cli": patch
---

**Kindgi login profiles: a login for each runtime.**
- `kindgi auth login --profile <name> --url <url> --token-stdin` keeps a login under that name in `~/.kindgi/config.json`, beside the login without a name. A command uses it only when it names it: `--profile <name>`, or `KINDGI_PROFILE=<name>` in that shell. No current profile is stored, and a profile's key is never found by its address: a command that would need it is refused, naming the profile to add.
- `--profile` beats `KINDGI_API_URL` and `KINDGI_API_TOKEN`, and says so on stderr. `KINDGI_PROFILE` beside either is refused. `--url` and `--token` still win, but a `--url` for another address than the profile's is refused. A profile skips this folder's `.kindgirc.json`. `kindgi dev` refuses `--profile` and ignores `KINDGI_PROFILE`.
- A name the file doesn't hold is refused, listing the ones it holds, and so is an entry that can't be used, when it's named.
- `kindgi auth login --token-stdin` reads the key from stdin, for any login, so it lands in no shell history or `ps`. A key given that way is saved where a stored key for another address would be refused. Under a profile, login never reads the env vars, and a profile for another address is kept unless `--force`.
- `kindgi auth list` shows each login's name, address and file, and whether it can be used, never a key. `kindgi auth logout [--profile <name>]` removes one. `kindgi auth whoami` gains `profile`.
- `kindgi doctor` names a profile's key, and warns about a profile that can't be used. The sign-in hints name `--profile` and `--token-stdin`.
