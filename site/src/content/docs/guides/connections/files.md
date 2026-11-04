---
title: Files
description: Let a tool find, read and add files in someone's Google Drive or OneDrive, and find their organization's SharePoint libraries, with the least access each call needs.
sidebar:
  order: 18
  label: Files
---

The file tools work on the files of the account someone connected: their
own, or, with `as: 'company'`, the company's that a tenant admin connected.
There are three for Google Drive, and four for OneDrive and SharePoint.
Each one asks for the least access its call takes.

They use the same Google or Microsoft connection as the mail and calendar
tools. Turn on the files in your client or app first: the **Google Drive
API** ([Google](../google/#1-create-the-client-in-the-google-cloud-console),
step 1), or the Files permissions
([Microsoft](../microsoft/#2-register-the-app-in-microsoft-entra), step 3).

## The tools

| What it does | Google | OneDrive | What it asks for |
| --- | --- | --- | --- |
| Lists or searches the account's own files | `googleDriveFilesList` | `oneDriveFilesList` | Google: see and download all your Drive files (`drive.readonly`). Microsoft: see the files in your OneDrive (`Files.Read`). |
| Lists the files others share, and a SharePoint library's | Google's list includes those shared | `oneDriveSharedFilesList` | See all the files you can open, those others share with you too (`Files.Read.All`). |
| Finds SharePoint sites and their libraries | None | `sharePointLibrariesList` | See the files and lists on your organization's SharePoint sites (`Sites.Read.All`). |
| Reads one file into the run | `googleDriveFileGet` | Not yet | The same as Google's list. |
| Adds a file | `googleDriveFileCreate` | `oneDriveFileCreate` | Google: add files to your Drive, and see and change those it added (`drive.file`). Microsoft: see, add and change the files in your OneDrive (`Files.ReadWrite`). |

Google's are in `@kindgi/connections/google/tools`, and OneDrive's and
SharePoint's are in `@kindgi/connections/microsoft/tools`. A pack includes
one as it includes a mail tool, as a tool folder whose `index.ts` names its
id:

```ts excerpt
import { googleDriveFilesList } from '@kindgi/connections/google/tools';

export default googleDriveFilesList({ id: 'acme.drive.list' });
```

For the company's files, give the tool its own id, since `as` is part of
what the tool declares:

```ts excerpt
export default googleDriveFilesList({ id: 'acme.store-drive.list', as: 'company' });
```

## Finding files

A list gives at most `top` files, 25 when it's left out and 50 at most.
When more remain, it gives `next`: the tool calls again with `next` and the
same other fields for the next page.

### Google Drive

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

### OneDrive

`oneDriveFilesList` reads the account's own OneDrive:

- with `text`, the files whose name, details or content match its words,
  across the drive;
- with `folderId`, what's in that folder, by its `id` from a list;
- with neither, what's at the drive's top level.

Each file comes with the same fields as Google's. A folder's `contentType`
is `inode/directory`, since Microsoft gives a folder none. A file someone
shared that the person added to their own OneDrive also gives its
`driveId`, the drive it's kept in, and its `owner` when Microsoft names one.

## Files others share, and SharePoint libraries

Google's list already includes the files others share. In OneDrive, they're
in other people's drives and in SharePoint, so `oneDriveSharedFilesList`
reaches past the account's own drive:

- With `text` alone, it searches what the account can open: its own files
  and those others share with it. A file in another drive gives its
  `driveId`, and its `owner` when Microsoft names one.
- With a `driveId`, from a shared file or a SharePoint library, it lists
  that drive: its top level, a folder in it by `folderId`, or, with `text`,
  what matches in it. Each file gives that `driveId`, so a folder's `id` and
  its `driveId` list what's in the folder.

`sharePointLibrariesList` finds the SharePoint sites that match `text`, at
most `top` (5 when it's left out, 10 at most), and gives each one's
document libraries, each with its `driveId` for the shared list:

```json
{
  "libraries": [
    {
      "driveId": "b!Xy9...",
      "name": "Documents",
      "link": "https://acme.sharepoint.com/sites/finance/Shared%20Documents",
      "site": { "name": "Finance", "link": "https://acme.sharepoint.com/sites/finance" }
    }
  ]
}
```

SharePoint is for work and school accounts. A personal Microsoft account
has none, and its search is refused.

## Reading a file

A get reads one file by its `id` and stores it as a file of the run, so
the agent is shown it, as a mail attachment is
([Ready-made tools](../use-a-connection/#ready-made-tools)). For now, only
Google Drive's:

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

A create adds a file from either:

- `text`, with a `name` and a `contentType`: `text/plain` (when it's left
  out), `text/markdown` or `text/csv`; or
- a `file` of the run, by its file value, as a get, a mail attachment or
  the run's input gave it. It keeps its own name unless `name` is given.

The answer is the new file, as a list gives it.

Because a file goes into someone's drive, a create in a run that no person
started waits for a yes first: the person's, or a reviewer's for the
company's drive, just as for a send
([Ask before a tool runs](../../approvals/ask-before-a-tool-runs/)). On
the person's own drive, a list and a get wait for their yes too, as every
call with a person's connection does in such a run
([Use a connection](../use-a-connection/#approvals)).

A create runs once per call. If its step runs again, after a wait or a
retry, it gets the first call's answer.

### Google Drive

The file goes at the top of the Drive. With `convert: true`, text or
Markdown becomes a Google Doc, and CSV a Google Sheet.

The create asks for `drive.file`, which reaches only the files the tool
added, never the person's others. So it can't add a file to a folder of
theirs.

If the runtime stopped between adding the file and keeping the answer, the
create finds the file it added and answers that, rather than adding a
second.

### OneDrive

The file goes at the top of the OneDrive, or in a folder by its `folderId`
from a list.

A create never replaces a file. When one of that name is already in the
folder, the call fails, saying so, and the agent can give another `name`.
The one exception is a file of that name with the same size: the create
answers it as the file it added, since that's what it finds when the
runtime stopped between adding the file and keeping the answer.

## Permissions and review

Your own client or app asks for these permissions, so Google and Microsoft
review your registration, not Kindgi's.

- **Google:**
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
- **Microsoft:**
  - `Files.Read`, for the own list, and `Files.ReadWrite`, for the create,
    reach the account's own OneDrive. For a personal account, they reach
    the files others share with it too.
  - `Files.Read.All`, for the shared list, reaches every file the account
    can open. `Sites.Read.All`, for the libraries list, reaches the
    organization's SharePoint sites.

  Whether people may allow these themselves is your directory's setting
  ([Admin consent](../microsoft/#admin-consent)). In a directory on
  Microsoft's default for new tenants, they can allow `Files.Read` and
  `Files.ReadWrite`, while `Files.Read.All` and `Sites.Read.All` need an
  admin's consent once. So a pack that reads only the account's own
  OneDrive needs no admin.

## A connection made before

A connection someone made for mail or a calendar has only those
permissions. In a run they started, a file tool's call waits for them to
allow the files, as for any permission a connection lacks
([When the connection is missing](../use-a-connection/#when-the-connection-is-missing)).
In any other run, it fails with `connection-missing`
([Errors when a call uses a connection](../reference/#errors-when-a-call-uses-a-connection)).
Connecting again asks for what the connection had as well as the files, so
their mail and calendar keep working, with Google and with Microsoft.

## Limits

- **Google:** Kindgi paces each connection's Drive calls at 325,000 of
  Drive's quota units a minute
  ([Google: Usage limits](https://developers.google.com/workspace/drive/api/guides/limits)):
  - **A list** costs 100. A create's check for a file it added before is a
    list too.
  - **A file's details** cost 5, and **a download or an export** 200.
  - **A create** costs 50, and one over 5 MB 50 more, for the upload of its
    bytes.

  Drive calls don't count in Gmail's or the calendar's units. Google
  enforces its limit for your whole Cloud project itself.
- **Microsoft:** Kindgi paces each connection's OneDrive and SharePoint
  calls at 3,000 in 5 minutes, SharePoint Online's default for one person
  ([Microsoft: Avoid getting throttled or blocked in SharePoint Online](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)).
  Microsoft names no limit for a personal OneDrive, so Kindgi keeps the
  same pace there. A libraries list is one call for the search and one for
  each site. File calls don't count in the mailbox's limits
  ([Microsoft](../microsoft/#limits)). A call over a limit Microsoft keeps
  itself is refused with a time to wait, and `appFetch` tries again.

## Not here yet

- Reading a OneDrive or SharePoint file into the run.
- Choosing files with Google's file picker.
- Changing, moving, sharing or deleting a file, and adding a folder.
