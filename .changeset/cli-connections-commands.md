---
"@kindgi/cli": patch
---

**`kindgi connections` and `kindgi connection-apps`: connect accounts at other apps from the terminal.**
- **`kindgi connections`**: `list` (yours, or every one for a tenant admin; `--project`, `--app`, `--mine`, `--include-removed`), `get`, `connect <app>` and `disconnect <id>`.
  - `connect` makes a connect request and prints the link to open. At a terminal it waits until the connect finishes and says whose account it connected. When the app granted less than asked, it still says whose account it connected, and what's missing, and exits 1. `--permissions` names what it asks for. Left out, it asks at the terminal about each permission the app's entry offers, none picked for you; without a terminal, `--permissions` is required. `--for-company` connects the company's account (tenant admins).
  - `disconnect` withdraws the access at the app where it can, destroys the token, and says what was done at the app.
- **`kindgi connection-apps`** (tenant admins): `list` (`--include-removed`), `get`, `add google` and `add github`, and `remove <id>`.
  - `add` takes the app's client id and names its secrets by reference, `<env>/<name>` (or `<name>` under the env the runtime serves). Store the values first with `kindgi secrets set`. `add github` also takes the GitHub App's App ID (`--github-app-id`), its slug, private key and webhook secret. It prints the registration, with the redirect and notices addresses to give the app.
  - `remove` refuses a registration with live connections unless `--with-connections`, which disconnects them too.
- `disconnect` and `remove` ask first at a terminal. Without one they need `--yes`.
- `--json` prints the server's answer for `connect`, `disconnect` and `remove`, and `connect --json` doesn't wait.
- **`kindgi runs resume <run-id>`** names a connect the run waits for: the app, what it asks for, and the link to connect it, with when the link stops working. A run that waits only for a connect exits 6. Next to an approval or another system's answer, the connect is listed after them, and the exit code stays theirs. `--json` adds `connections`. `kindgi runs get` prints the same line per connect after the run's JSON, on stderr.
