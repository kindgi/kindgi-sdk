# @kindgi/connections

The app entries a Kindgi server reads to connect accounts at other apps:
a member's own Google account, say, or the company's GitHub App. A tool
then acts with that account, and the server keeps its tokens.

An entry is data. It says:

- **how a person signs in** at the app (`signIn`): OAuth 2.0 with PKCE, or a
  GitHub App's installation;
- **who may own a connection** (`owners`): a member, the company, or either;
- **what each permission allows,** in plain words for the person asked
  (`permissions`), and whether it changes anything;
- **whose account it is** (`account`), learned from an ID token or the
  installation;
- **how access is withdrawn** on a disconnect, and how the app reports a
  removal made at the app (`removal`);
- **the app's rate limit,** per connection (`rateLimits`);
- **the docs page** an admin follows to register the app (`setupGuide`).

```ts
import { google } from '@kindgi/connections/google';
import { github } from '@kindgi/connections/github';

google.permissions['gmail.send'].says; // 'Send mail as you'
github.owners;                         // ['company']
```

`defineApp(entry)` checks an entry and returns a frozen copy. A field that's
wrong throws a `TypeError` naming it: an id or a permission key that isn't a
lowercase slug, a URL that isn't `https:`, an account lookup or a revoke
that doesn't fit the sign-in kind.

The code that talks to an app's token endpoints is the server's, one per
sign-in kind. A new app that signs in with plain OAuth 2.0 needs only its
entry.

Apache-2.0.
