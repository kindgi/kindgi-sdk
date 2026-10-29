---
"@kindgi/cli": patch
---

**The CLI names connections, chooses which company connection an agent or a flow uses, and points a mail trigger at one.**
- A `<connection>` is its id or its name: its label, else its account's label, matched without regard to case. A name looks through every page of the connections it may be. A name that several connections have is refused, listing each one's name, account, app, whose it is and id; `--app` narrows it where the command has it. A name none has is refused, saying how to list them.
- `kindgi connections list` shows a LABEL column first: the connection's label, else its account's label. The JSON output is the server's.
- `kindgi connections connect <app>` takes `--label=<name>`, the new connection's name, and `--reconnect=<connection>`, one of yours (or, with `--for-company`, of the company's) at the app to sign in to again, which keeps its name. The finish names the connection by its label, with its account: `Connected support (support@acme.example at google, company)`.
- `kindgi connections update <connection> --label=<name>` renames a connection, and says its old name and its new one.
- `kindgi connection-choices` (project admins; members list them):
  - `set <connection> --agent=<id>` (or `--flow=<id>`) chooses one of the project's company connections for an agent or a flow at its app, and says which choice it replaced, if any.
  - `list` shows the project's choices (`--agent`, `--flow`, `--app`, `--include-removed`); `--table` names each connection.
  - `unset <choice-id>` removes one, asking first at a terminal; without one it needs `--yes`.
- `kindgi mail-triggers create` and `update` take `--connection=<connection>` with `--as=company`: the company connection the mailbox is read with, one of the project's at the mailbox's app. On a person's mailbox it's refused before anything is sent. On update it goes with `--mailbox` and `--as`. When the project has several and none is named, the error lists them and the command again with each one. The `--table` MAILBOX column names the connection a trigger reads with (`google company support`).
- A connection the server can't find names the flag that sent it (`--reconnect`, `--connection`).
