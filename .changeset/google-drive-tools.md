---
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**Tools for Google Drive.** `googleDriveFilesList`, `googleDriveFileGet` and `googleDriveFileCreate`, from `@kindgi/connections/google/tools`, find, read and add files in the Drive of the Google account the run acts as, or the company's with `as: 'company'`.

- **The list** gives the files others share with the account too, never what's in the trash: the newest first, or, with `text`, the best matches first. It narrows by words in a file's name or content, words in its name, a folder, a kind or a time. Each file comes with its `id`, `name`, `kind`, `contentType`, `size`, `modified`, `link`, `folderId`, and `owner` when that's someone else, and `next` gives the next page.
- **The get** stores one file as a file of the run, as an attachment tool does. A Google Doc is read as Markdown, a Sheet as CSV, Slides as text and a Drawing as a PNG, or each as a PDF with `format: 'pdf'`. Other files are read as they are when they're a JPEG, PNG or WebP image, a PDF, or a text, Markdown or CSV file, within its type's size limit. Else the answer says why the file isn't shown (`notShown`). The answer also gives the file as the list does (`listed`).
- **The create** adds a file at the top of the Drive from `text` or from a file of the run. With `convert: true`, text or Markdown becomes a Google Doc and CSV a Google Sheet. In a run no person started, it waits for a yes. It runs once per call: run again, it gives the first call's answer, and it finds a file the call added before rather than adding a second.
- **Permissions.** The Google entry adds `drive.readonly`, with review `restricted`, for the list and the get, and `drive.file`, with review `none`, for the create: it reaches only the files the app added. A connection made before lacks them until the person allows it. Turn on the Google Drive API in your OAuth client and add them to its Data access.
- **Pacing.** A new rate limit paces each connection's Drive calls at 325,000 of Drive's quota units a minute, at Drive's cost for each call. Drive calls don't count in Gmail's or the calendar's units, and a Gmail attachment's download no longer counts in the calendar's. Outlook's send, reply and event writes are now named in its sends limit, at the 1 they cost before.
- **Your own calls.** `appFetch`'s `body` takes bytes as well as text, and sends them as they are.
- **Versions.** The three tools start at 1.0.0, as person and as company.
- **Docs.** A new Files guide shows the tools, the Google setup guide adds the Drive API and the two permissions, the connections overview and Use a connection list the tools, and the tools authoring skill names them.
