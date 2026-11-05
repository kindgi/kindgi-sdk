---
title: Files and versions
description: What a file is in Kindgi, how each edit is kept as a version, and how runs, pins and retention name and keep versions.
sidebar:
  order: 6
---

This page explains how Kindgi keeps files: every edit as a version, each
run's files at the version it took, and what keeps a version or lets it go.

## A file and its versions

A **file** is a document Kindgi keeps for you, such as a contract a run
drafted, a sheet your app sent in, or a report a tool wrote. It has an id,
`fileId`, and a name, and it belongs to a project.

Each time a file's bytes change, Kindgi keeps the change as a **version**.
Version 1 is the file as it was first stored, then come 2, 3 and so on. A
number is never used twice, even after its version is deleted. Each version
keeps:

- its bytes, name, type, size, sha256 and tags;
- how it was made: an upload, a restore, a tool or the model;
- who made it: a person, a service account or a run;
- when a run made it, the run and the tool.

**Latest** is the file's highest version that isn't deleted. Only two
things move it: a version being added, and Latest itself being deleted,
which moves it to the next live version down.

## Adding a version

A person adds a version by uploading the file's bytes again, or by
restoring an earlier version. A tool that declares `updatesFiles` adds one,
and so does the model, through the `kindgi_update_file` built-in tool. A
tool or the model can update only a file its run was given or made.

- **The same bytes add nothing.** When the bytes' sha256 is Latest's, no
  version is added. The answer is Latest, with `created: false`.
- **A restore keeps the history.** Restoring version 2 adds a version with
  version 2's bytes, which records that it was restored from 2. Nothing is
  removed.
- **Two writers at once.** A write that sends `expectedVersion` is refused
  with `409 file-version-conflict` when Latest isn't that version, and its
  details carry both numbers. A write without `expectedVersion` is
  last-write-wins: it becomes Latest whatever came in between. Nothing is
  lost, because the version in between stays in the history. Tools, the
  model and the console always send `expectedVersion`.

## Naming a file

Wherever you name a file, such as in a run's input files, the files API or
the console, you can name its Latest, `{ fileId }`, or one version,
`{ fileId, version: 3 }`.

A run's input files also take `{ artifactId }`, which names bytes, not a
version: the run holds the newest version with those bytes that isn't
deleted or purged. A file value passed back in, with its `artifactId`,
`fileId` and `version`, is taken only when that version's bytes are the
artifact's. `artifactId` is one of the names
[0.8.0 removes](#what-080-removes).

A run takes Latest once, when it first takes the file, and holds that exact
version from then on. A version added later reaches the run only if someone
passes it in, or if the run makes it. A version the run holds that's later
deleted or purged reads as gone: the run never falls back to Latest.

Starting a run is refused with `400 bad-input`, naming the input file, when
the file isn't there or you can't read it, when it has no such version, or
when the version is deleted or purged: the start never falls back to Latest.
It's refused the same way when the file is in a project other than the
run's, when it's over the size a model is shown for its type, or when it's
a type no model is shown. A run that can call a tool that declares
`readsFiles: true` also takes a file of a type no model is shown, up to
10 MB, since its tools can read it. An `artifactId` given with only one of
`fileId` and `version`, or with a pair that names other bytes, is refused
the same way, as is an `artifactId` whose versions are all deleted or
purged. On a runtime without a file store, a start with any input file is
refused with `400 bad-input`.

A flow passes exact versions from step to step, and a flow's run input can
name a fixed version. Each file a run read or wrote is a node in the run's
[provenance](../../guides/observability/trace-an-answer/) graph, with the file's
id, the version and its sha256.

## Pins

A **pin** is a keep mark on one version, with who set it, when and why. A
file can have any number of pins, one per version: pinning a version that's
already pinned changes nothing.

- A pinned version can't be deleted: it answers `409 file-version-pinned`.
- Retention never purges a pinned version.
- A pin never moves Latest.

Every pin and unpin is kept in the file's pin history, which is never
edited.

## Comparing two versions

Comparing two versions runs on the server, and either side can be Latest.

- **A text file** gets the lines that changed, with 3 lines of context. A
  file is text when its type is `text/*`, JSON, XML or CSV, or a `+json` or
  `+xml` type, and its bytes are UTF-8 with no NUL.
- **Any other file** gets each side's size and sha256, and whether they're
  the same. So does a compare past a limit. The answer says why the lines
  weren't compared:
  - `not-text`: either side isn't text;
  - `too-large`: a side is over 1 MiB or 20,000 lines;
  - `too-many-changes`: over 500 lines changed.

To see more than that, download both versions.

## Deleting and keeping

- **A version** that's deleted is gone from the file's reads, and its number
  isn't used again. The file's only live version can't be deleted on its
  own: it answers `409 file-last-version`, and you delete the file instead.
- **A file** that's deleted goes with every version. It answers `409` while
  any of its versions is pinned.
- **A run** that's deleted takes the files it created with it, unless
  someone pinned one or added a version from outside the run. The versions
  it added to other files stay, because they're those files' history.

A deleted file or version stays in the database until retention purges it.
With no policy on the `file_version` domain, every version is kept. The
tenant's `*` policy doesn't cover the domain: a policy has to name it, as
it does `memory` and `conversation`. A policy on `file_version` purges a
version when:

- it was deleted longer ago than the policy's period; or
- it isn't Latest, isn't one of the file's 10 most recent versions, isn't
  pinned, and it stopped being Latest longer ago than the period.

A purged version leaves its number, sha256, size, who made it and when, so
the file's versions still list it, as purged, and the runs that held it
still name it. [Keep and purge deleted data](../../deploy/retention/) has
the policies.

## Who can see and change a file

Files follow the same rules as the rest of a project, with
[authorization](../../deploy/authorization/) on:

- **Reading** a file needs `read` on its project. A person who may only run
  there reads their own files, the ones they made or a run of theirs made,
  with all their versions.
- **Creating** a file needs `write`, or `run` for a file of your own that
  names no run, such as an input for a run you start.
- **Changing** a file needs `write`: adding, restoring or deleting a
  version, pinning or unpinning one, and deleting the file.

A file you can't read answers `404 file-not-found`, as if it weren't there,
and lists leave it out.

## Where files are kept

The runtime keeps files once its file store is on, on disk or in a bucket:
[Choose where the runtime keeps files](../../deploy/self-hosted/store-files/).
On a runtime without it, the files routes answer `404 route-not-found`, and
the console's Files pages say files aren't offered there.

An id `artifacts.upload` answered is its file's id, and a file stored
before versions were kept reads as a file with one version, under the same
id.

## What 0.8.0 removes

0.8.0 removes the names below. Until then, each works as it did and says
what replaces it: the API marks its operations deprecated, and each of its
answers carries a `Link` header with `rel="deprecation"` to this section.
The clients mark their methods deprecated, Python's warn, and the CLI's
`kindgi artifacts` prints a line on stderr.

| The name that goes | What to use |
| --- | --- |
| `GET /v1/artifacts` (`artifacts.list`) | `GET /v1/files` (`files.list`), with the same `contentType` filter |
| `POST /v1/artifacts` (`artifacts.upload`) | `POST /v1/files` (`files.create`), with the same `tags` |
| `GET /v1/artifacts/{blobId}` (`artifacts.download`) | `GET /v1/files/{fileId}/versions/{version}/content` (`files.versions.download`) |
| `HEAD /v1/artifacts/{blobId}` (`artifacts.head`) | `GET /v1/files/{fileId}/versions/{version}` (`files.versions.get`) for the record, or `HEAD /v1/files/{fileId}/versions/{version}/content` for the headers alone |
| `DELETE /v1/artifacts/{blobId}` (`artifacts.delete`) | `DELETE /v1/files/{fileId}/versions/{version}` (`files.versions.delete`), or `DELETE /v1/files/{fileId}` (`files.delete`) for the whole file |
| `413 artifact-too-large` | `413 file-too-large`, which the files routes answer |
| TypeScript and Python `client.artifacts`, Java `client.artifacts()` | `client.files`, `client.files()`, with the method each deprecation names |
| `kindgi artifacts list` | `kindgi files list`, with the same flags |
| `kindgi artifacts get <id>` | `kindgi files get <file-id> <version>` |
| `kindgi artifacts download <id>` | `kindgi files download <file-id> <version>`, with the same flags |
| `kindgi artifacts upload` | `kindgi files upload`, which takes the type from the file's extension. `--content-type=application/octet-stream` keeps the type `kindgi artifacts upload` gave every file. |
| `kindgi artifacts delete <id>` | `kindgi files delete <file-id> <version>`, which deletes that version only. `kindgi files delete <file-id>` deletes the file and every version. Both ask first, and with no terminal and no `--yes` delete nothing. |
| `KINDGI_ARTIFACTS` and `KINDGI_ARTIFACT_MAX_BYTES` | `KINDGI_FILES` and `KINDGI_FILE_MAX_BYTES`. A runtime that finds an old name set refuses to start, and says the name to use. |
| A file value's `artifactId` | Its `fileId` and `version`. A caller that sends `artifactId` is refused with `400 bad-input`. |
| The `artifacts` section of `kindgi exports`, and its `artifacts/` folder | Its `files` section, with the bytes under `files/` |
| A provenance node's kind `artifact` | The kind `file`, for the same node |

An id that `artifacts.upload` or `kindgi artifacts upload` answered moves to
`fileId` as it is, with `version` 1. A later version's blob id isn't a file
id: `files.get` and `kindgi files get` answer `404 file-not-found` for one.
`artifacts.list` and `kindgi artifacts list`'s JSON answer each item's
`fileId` and `version`, and a file value that names a blob carries them
beside `artifactId`. Those are what to move to; `kindgi artifacts get` is a `HEAD`,
which carries neither. A file value with only `artifactId`, kept from an
earlier runtime, names the file with that id. A run that takes one as an
input file holds the newest version with those bytes that isn't deleted or
purged: version 1, unless a restore gave those bytes a later version.
