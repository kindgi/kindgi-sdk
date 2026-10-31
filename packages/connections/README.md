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
  as the person whose Google connection the call has; `gmailMessagesList`
  lists or searches their mailbox; `gmailMessageGet` reads one message
  whole, as a `MailMessage`; `gmailAttachmentGet` stores one of its
  attachments, by its number in the message's list, as a file the agent is
  shown (a JPEG, PNG or WebP image, a PDF, or a text, Markdown or CSV file,
  within its type's size limit); and `gmailReply` answers one in its thread.
- `@kindgi/connections/microsoft/tools`: `outlookSend`,
  `outlookMessagesList`, `outlookMessageGet`, `outlookAttachmentGet` and
  `outlookReply`, the same for Outlook.
- Calendars, from the same two subpaths: `googleCalendarEventsList` and
  `outlookCalendarEventsList` list the events in a window,
  `googleCalendarFreeBusy` and `outlookCalendarFreeBusy` say when the
  calendar is busy, and `googleCalendarEventCreate`,
  `outlookCalendarEventCreate`, `googleCalendarEventUpdate` and
  `outlookCalendarEventUpdate` add or change an event and invite the
  people it names.
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
first project that publishes it. Sending, replying, labelling and
posting are `mutating`, and wait for a person's yes in a run no person
started. So does a read with a person's connection, such as a mail read
without `as: 'company'`, and in a run a mail started, so does a read with
that mailbox's own connection.

A reply goes to the one address the mail asks for, its Reply-To, else
its From, and the call's `to` must name it. A Reply-To that names no
address, such as an empty group, counts as none. A reply to a mail that
names more than one address, none, one that isn't an address, or the
mailbox's own is refused, and sends nothing. The sender of a mail chooses
both headers, so an agent that replies mustn't give out an order's details
on the From address alone.

A mail tool acts in the person's own mailbox. With `as: 'company'` it uses
the company's instead, connected by signing in as that mailbox
(`support@acme.example`). `as` is part of what the tool declares, so an id
you've published keeps its `as`: give a company mailbox its own tool id
(`acme.support-mail.list`).

`@kindgi/connections/google/mail` and `@kindgi/connections/microsoft/mail`
are `googleMail` and `microsoftMail`: the calls a runtime makes to watch a
mailbox for new mail and read each one, with its thread, for a run
(`MailFunctions`, from `@kindgi/connections/mail`).

Each calls its app's API with `appFetch(ctx, call)`, from
`@kindgi/connections/app-fetch`, which a tool of your own can use too. It
sends the connection's token as the only `Authorization`, paces calls by the
entry's rate limits, tries a busy answer again, and throws a 401 as
`ConnectionRejectedError` so the runtime renews the token once.

`kindgi init --template=follow-up` scaffolds a pack whose agent writes a
follow-up mail from your notes and sends it with `gmailSend` once you
approve it.

Apache-2.0.
