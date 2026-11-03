# @kindgi/connections-inmemory

An in-memory `ConnectionBinding` and `ConnectionResolver` for Kindgi
connections, with a fake app in place of Google's or GitHub's servers. It's
for development and tests: everything lives in the process, and it refuses
to start under `NODE_ENV=production` unless you pass `productionSafe: true`
for a parity test.

```ts
import { createApp } from '@kindgi/api';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import { createInMemoryConnections } from '@kindgi/connections-inmemory';

const connections = createInMemoryConnections({
  entries: [google, github],
  publicUrl: 'http://localhost:3000',
});
const app = createApp({ /* … */ envName: 'local', connections: connections.binding });
```

**A connect without a browser.** Start the request, read `state` from its
`authorizeUrl`, and finish with `code: 'ok'`, or `error: 'access_denied'` for
a decline. Tokens are `fake-<connectionId>-<n>`.

**The fake app** (`app`) answers as an app where everything works, unless a
hook says otherwise:

- `exchange`: the account and the permissions granted for a code, or
  `'refused'`. `refreshToken: false` gives no refresh token (a GitHub App
  ignores it): a finish then keeps one the connection had before; else, for
  an app whose
  `signIn.refreshToken` is `'optional'`, the connection works until one
  minute before its token ends (`accessEndsAt`), and any other app's finish
  refuses it. `expiresIn: false` leaves out when the token ends, which a
  finish left with no refresh token refuses too;
- `renew`: `'ok'`, `'invalid-grant'` (the connection needs reconnecting), or
  `'unavailable'` (the call fails with `connection-renew-failed`);
- `withdraw`: a disconnect's revoke, `'ok'` or `'failed'`;
- `installations`: the GitHub App installations the person reaches (one by
  default; none sends the start to the install page);
- `notice`: what a notice from the app does. Without it, every notice is
  refused.

`seed.app` and `seed.connection` put a registration or a connection in
place directly; `seed.connection` with `refreshToken: false` is one
without a refresh token (only for an `'optional'` app). `calls` lists every
call to the fake app, never a token. `onConnectComplete` is told when a
run's connect finishes, as a server completes the run's wait.

**Connection choices.** `setChoice` needs to know a project's agents and
flows: pass `inProject`, which says whether an agent or a flow is one of a
project's. Without it, none is, and every choice is refused.

**Which company connection a call uses.** The resolver takes the run's
mailbox's connection, else the agent's or flow's choice, else the only
candidate, as a server does. Several and no choice is
`connection-not-chosen`; a picked one that can't serve the call is
`connection-missing`, naming it, never another one.

Apache-2.0.
