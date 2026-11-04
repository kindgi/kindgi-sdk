---
title: Files
description: Let a tool find, read and add files in someone's own Google Drive, with the least access each call needs.
sidebar:
  order: 18
  label: Files
---

The file tools work on the Drive of the Google account someone connected:
their own, or, with `as: 'company'`, the company's that a tenant admin
connected. There are three: a list, a get and a create. The list and the
get read; the create adds a file.

They use the same Google connection as the mail and calendar tools. Turn
on the **Google Drive API** in your client first
([Google](../google/#1-create-the-client-in-the-google-cloud-console),
step 1).

## The tools

| What it does | Tool | What it asks for |
| --- | --- | --- |
| Lists or searches the files | `googleDriveFilesList` | See and download all your Drive files (`drive.readonly`). |
| Reads one file into the run | `googleDriveFileGet` | The same as the list. |
| Adds a file | `googleDriveFileCreate` | Add files to your Drive, and see and change those it added (`drive.file`). |

They're in `@kindgi/connections/google/tools`. A pack includes one as it
includes a mail tool, as a tool folder whose `index.ts` names its id:

```ts excerpt
import { googleDriveFilesList } from '@kindgi/connections/google/tools';

export default googleDriveFilesList({ id: 'acme.drive.list' });
```

For the company's Drive, give the tool its own id, since `as` is part of
what the tool declares:

```ts excerpt
export default googleDriveFilesList({ id: 'acme.store-drive.list', as: 'company' });
```

## Finding files

A list gives the newest files first, those others share with the account
included, and never what's in the trash. It narrows by any of these:

- `text`: words in a file's name or content. Google then orders the files
  by how well each one matches.
- `name`: words in its name.
- `folderId`: what's in a folder, by the folder's `id` from a list.
- `kind`: `folder`, `document`, `spreadsheet`, `presentation`, `pdf` or
  `image`.
- `modifiedAfter`: a time with its offset.

Each file comes with its `id`, `name`, `kind` (`file` or `folder`),
`contentType`, `size`, `modified` (in UTC), `link` (its page in Drive),
`folderId`, and `owner` when that's someone else:

```json
{
  "files": [
    {
      "id": "1a2B3c",
      "name": "Q3 report.pdf",
      "kind": "file",
      "contentType": "application/pdf",
      "size": 52341,
      "modified": "2026-11-02T09:15:00Z",
      "link": "https://drive.google.com/file/d/1a2B3c/view",
      "folderId": "0F1n"
    }
  ],
  "next": "AHWq..."
}
```

A list gives at most `top` files, 25 when it's left out and 50 at most.
When more remain, it gives `next`: the tool calls again with `next` and the
same other fields for the next page.

## Reading a file

A get reads one file by its `id` and stores it as a file of the run, so
the agent is shown it, as a mail attachment is
([Ready-made tools](../use-a-connection/#ready-made-tools)):

- **Google's own files** are read as a type a model takes: a Doc as
  Markdown, a Sheet as CSV (its first sheet only), Slides as plain text,
  and a Drawing as a PNG. With `format: 'pdf'`, each one is read as a PDF.
  Google exports at most 10 MB.
- **Other files** are read as they are, when they're a JPEG, PNG or WebP
  image (at most 5 MB), a PDF (at most 10 MB), or a text, Markdown or CSV
  file (at most 1 MB).

A file of any other type, or a larger one, isn't downloaded: the answer
says why it isn't shown (`notShown`), with its name. The answer also gives
the file as a list does (`listed`). A folder isn't a file: list what's in
it instead.

## Adding a file

A create adds a file at the top of the Drive, from either:

- `text`, with a `name` and a `contentType`: `text/plain` (when it's left
  out), `text/markdown` or `text/csv`; or
- a `file` of the run, by its file value, as a get, a mail attachment or
  the run's input gave it. It keeps its own name unless `name` is given.

With `convert: true`, text or Markdown becomes a Google Doc, and CSV a
Google Sheet. The answer is the new file, as a list gives it.

The create asks for `drive.file`, which reaches only the files the tool
added, never the person's others. So it can't add a file to a folder of
theirs.

Because a file goes into someone's Drive, a create in a run that no person
started waits for a yes first: the person's, or a reviewer's for the
company's Drive, just as for a send
([Ask before a tool runs](../../approvals/ask-before-a-tool-runs/)). On
the person's own Drive, a list and a get wait for their yes too, as every
call with a person's connection does in such a run
([Use a connection](../use-a-connection/#approvals)).

A create runs once per call. If its step runs again, after a wait or a
retry, it gets the first call's answer. If the runtime stopped between
adding the file and keeping the answer, the create finds the file it added
and answers that, rather than adding a second.

## Permissions and review

Your own client asks for these permissions, so Google reviews your
registration, not Kindgi's.

- `drive.readonly`, for the list and the get, reads every file in the
  Drive. Google counts it as restricted, as it does reading mail.
- `drive.file`, for the create, reaches only the files the app added.
  Google counts it as neither sensitive nor restricted.

What that means for your client:

- With **Audience: Internal**, there's no review.
- With **External**, an app Google hasn't verified shows its "unverified
  app" screen and takes at most 100 accounts, as for Gmail
  ([Google](../google/#1-create-the-client-in-the-google-cloud-console)).
  Google's verification for a restricted permission also asks for a
  security assessment each year
  ([Google: Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).

Verification is per client, and one client serves all the workspace's
packs. Once any pack reads Drive, the client's consent screen lists
`drive.readonly`. A pack that only adds files asks for `drive.file` alone.

## A connection made before

A connection someone made for mail or a calendar has only those
permissions. In a run they started, a file tool's call waits for them to
allow Drive, as for any permission a connection lacks
([When the connection is missing](../use-a-connection/#when-the-connection-is-missing)).
In any other run, it fails with `connection-missing`
([Errors when a call uses a connection](../reference/#errors-when-a-call-uses-a-connection)).
Connecting again asks for what the connection had as well as Drive, so
their mail and calendar keep working.

## Limits

Kindgi paces each connection's Drive calls at 325,000 of Drive's quota
units a minute
([Google: Usage limits](https://developers.google.com/workspace/drive/api/guides/limits)):

- **A list** costs 100. A create's check for a file it added before is a
  list too.
- **A file's details** cost 5, and **a download or an export** 200.
- **A create** costs 50, and one over 5 MB 50 more, for the upload of its
  bytes.

Drive calls don't count in Gmail's or the calendar's units. Google enforces
its limit for your whole Cloud project itself.

## Not here yet

- OneDrive and SharePoint.
- Choosing files with Google's file picker.
- Changing, moving, sharing or deleting a file, and adding a folder.
