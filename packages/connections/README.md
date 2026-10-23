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

## Tools

Ready-made tools that act with a connection, one subpath per app:

- `@kindgi/connections/google/tools`: `gmailSend` sends a plain-text mail
  as the person whose Google connection the call has.
- `@kindgi/connections/github/tools`, on the company's GitHub connection:
  `githubIssuesList`, `githubLabelsList`, and `githubIssuesAddLabels`, which
  adds only labels the repository has.
- `@kindgi/connections/linkedin/tools`: `linkedinPost` posts text on
  LinkedIn as the person whose LinkedIn connection the call has, to anyone
  or to their connections only. The text is posted as written: a `#` that
  starts a word is a hashtag, and LinkedIn's markup is escaped, so a post
  mentions no one.

Each is a factory: a pack includes one under an id it names, in a tool
folder whose `index.ts` is one line.

```ts
import { gmailSend } from '@kindgi/connections/google/tools';

export default gmailSend({ id: 'acme.gmail.send' });
```

The id is the pack's because a tool id is the tenant's, filed under the
first project that publishes it. Sending, labelling and posting are `mutating`, and
wait for a person's yes in a run no person started.

Each calls its app's API with `appFetch(ctx, call)`, from
`@kindgi/connections/app-fetch`, which a tool of your own can use too. It
sends the connection's token as the only `Authorization`, paces calls by the
entry's rate limits, tries a busy answer again, and throws a 401 as
`ConnectionRejectedError` so the runtime renews the token once.

`kindgi init --template=follow-up` scaffolds a pack whose agent writes a
follow-up mail from your notes and sends it with `gmailSend` once you
approve it.

Apache-2.0.
