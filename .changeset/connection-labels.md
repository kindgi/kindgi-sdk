---
"@kindgi/api": patch
"@kindgi/connections-inmemory": patch
"@kindgi/client": patch
---

**A connection has a name, its `label`.** `POST /v1/connections` takes an optional `label`, the name to give the connection it makes: trimmed, 1 to 100 characters, with no control or format characters (such as bidi overrides or zero-width characters), else `400 bad-input` with `details.field` `label`. When the connect finishes, a new connection takes that name, or else its account's, such as an email address, without its control or format characters and cut to 100 characters. One owner's live connections to an app in an environment each have their own name, whatever the case: a name another of them has is refused at the connect (`409 connection-label-taken`), and a new connection whose name was taken in the meantime gets the first free number after it, such as `ana@acme.com 2`. A reconnect keeps the connection's name, so the one it asks for isn't checked. `PATCH /v1/connections/{connectionId}` (`client.connections.update(connectionId, { label })`) renames one: its owner or a workspace admin may, as for a disconnect, and anyone else gets `404 connection-not-found`. A taken name is `409 connection-label-taken`. A connection and a connect request carry `label` when they have one; a connection made before connections had names has none. `ConnectionBinding` gains `update`, and its errors `connection-label-taken`.

- `@kindgi/connections-inmemory`: names connections the same way, and renames them with `update`. A seeded connection takes an optional `label`, and none by default.
