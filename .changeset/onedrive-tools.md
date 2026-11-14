---
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**Tools for OneDrive and SharePoint.** `oneDriveFilesList`, `oneDriveSharedFilesList`, `sharePointLibrariesList` and `oneDriveFileCreate`, from `@kindgi/connections/microsoft/tools`, find and add files in the OneDrive of the Microsoft account the run acts as, or the company's with `as: 'company'`, and find the files others share with it and its organization's SharePoint libraries.

- **The own list** reads the account's OneDrive: with `text`, the files whose name, details or content match, across the drive; with `folderId`, what's in that folder; with neither, its top level. Each file comes with the same fields as a Google Drive list's, and `next` gives the next page. A folder's `contentType` is `inode/directory`.
- **The shared list** searches, with `text`, what the account can open, those others share with it too, or lists a drive by its `driveId`: its top level, a folder in it, or what matches in it. A file in another drive gives its `driveId`, and its `owner` when Microsoft names one.
- **The libraries list** finds the SharePoint sites that match `text`, at most `top` (5 when it's left out, 10 at most), and gives each one's document libraries with their `driveId`, for the shared list.
- **The create** adds a file at the top of the OneDrive or in a folder by its `folderId`, from `text` or from a file of the run. It never replaces a file: when one of that name is already there, it fails, saying so, unless that file has the same size, which it answers as the file it added. In a run no person started, it waits for a yes. It runs once per call: run again, it gives the first call's answer.
- **Permissions.** The Microsoft entry adds `Files.Read` for the own list, `Files.ReadWrite` for the create, `Files.Read.All` for the shared list and `Sites.Read.All` for the libraries list. On Microsoft's default for new tenants, the last two need an admin's consent once. A connection made before lacks them until the person allows it.
- **Pacing.** A new rate limit paces each connection's OneDrive and SharePoint calls at 3,000 in 5 minutes. File calls don't count in the mailbox's limits, and Outlook's calls don't count in the new one. The mailbox's 10,000 in 10 minutes now names each Outlook call, at the 1 it cost before.
- **`FileListed`** gains `driveId`, given only by OneDrive's lists.
- **Versions.** The four tools start at 1.0.0, as person and as company.
- **Docs.** The Files guide adds OneDrive and SharePoint, the Microsoft setup guide adds the Files and Sites permissions and the admin-consent default, the calendar guide's consent sentence is corrected, and the connections overview, Use a connection, the README and the tools authoring skill name the new tools.
