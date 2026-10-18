---
title: Send us feedback
description: What kindgi feedback submit sends to Kindgi, what Kindgi keeps and for how long, and how to hear back or take a report back.
sidebar:
  order: 6.5
---

When your coding agent finds a bug in Kindgi itself, it writes it to
`FEEDBACK.md` in your pack with `kindgi feedback write`. Sending it to us is
a second step, and it's yours. Nothing leaves your machine until you've seen
exactly what's sent and said yes.

## Send a report

Preview it first:

```sh
pnpm exec kindgi feedback submit --preview
```

It prints the report exactly as it would be sent, after
[redaction](#what-redaction-changes), with its digest. Nothing is sent. With
no entry named, the report holds every entry in `FEEDBACK.md` that wasn't
sent yet and isn't marked fixed. To send particular entries, name them by id
or hash (`kindgi feedback submit 2026-10-15.1 --preview`).

Read it. If something in it shouldn't leave your machine, change the entry
in `FEEDBACK.md` and preview again. When it's right, send it with the
preview's digest:

```sh
pnpm exec kindgi feedback submit --yes=<digest>
```

It sends only if the report is still exactly what the preview showed. If
anything changed since, nothing is sent, and it asks you to preview again.
At a terminal, `kindgi feedback submit` without `--yes` shows the same
preview and asks `Send this to Kindgi (https://access.kindgi.com)? [y/N]`.
Only `y` or `yes` sends. With no terminal and no `--yes`, nothing is sent.

Your coding agent works the same way: the `kindgi-framework-feedback` skill
has it preview the report, show it to you, and send it only after you say
yes. If Kindgi may have received a report, it tells you, and leaves sending
it again to you.

Once a report is sent, each of its entries in `FEEDBACK.md` gains a line with
the report's id:

```md
- **submitted:** 2026-10-15T15:02:11.000Z · **report:** fbr_…
```

The key that withdraws the report stays on your machine, in
`~/.kindgi/feedback/keys.json`, which only you can read. It's never printed.
The report id isn't a secret, so `FEEDBACK.md` can be committed.

A report holds at most 20 entries and 64 KiB. An entry's title can be at
most 200 characters, and its body at most 16 KiB after redaction. With no
entry named, the oldest entries that fit are sent, and the rest wait for the
next run. `kindgi feedback submit` exits `0` when it sent the report, or had
nothing to send, and `1` otherwise.

When a send fails, it says whether the report may have arrived, and
`FEEDBACK.md` is left as it was:

- **`Nothing reached Kindgi: …`** It never connected. Send it again when you
  can.
- **`Nothing was sent: the intake is taking no more reports for now`**, with
  how long to wait when the intake says.
- **`The intake refused the report (…)`**, with why. Nothing was stored.
- **`Kindgi may have received it: …`** The answer was lost, came too late,
  or couldn't be read. Sending it again makes a second report. If the first
  one arrived, it can't be withdrawn from this machine, since its key never
  came back. Kindgi deletes it after 90 days.

## What's sent

The report goes to Kindgi's private intake, at
`https://access.kindgi.com/feedback/reports`. After redaction, it holds:

- **From each entry:** its id and hash, its title and body, its kind and
  severity, who found it (`by`), its date, and the SDK and CLI versions it
  records.
- **About your machine:** the CLI's version, the operating system and its
  release, the CPU architecture, the Node.js version, the pack's language,
  and `kindgi doctor`'s checks, each as its id and status only (`pass`,
  `warn`, `fail` or `skip`).

Nothing else is sent: no file, no env value, no key or token, no path
outside the pack, and not the pack's name, unless an entry's text carries
it past redaction. The preview is the report, byte for byte. The intake
refuses a report with any other field, at any level: it answers
`400 invalid-request`, naming the field but never its value
(`client.hostname is not a field here.`), and stores nothing.

## What redaction changes

Before the preview, the CLI redacts each entry's title and body, so the
preview shows what redaction did, and which of its rules changed each
entry:

- A private key's block becomes `[redacted]`.
- A value from the pack's env files becomes `[redacted]`: every `.env*` file
  at the pack's root, the files `dev.envFiles` names, and
  `.kindgi/secrets.env`. That's a value of 8 characters or more, or of 4 or
  more under a name that looks secret. A short value like `PORT=3000`
  stays.
- Known shapes of keys and tokens become `[redacted]`: model providers' and
  clouds' keys, `Bearer …`, and the value after a name that looks secret
  (`API_KEY=…`, `--api-key=…`, `"token": "…"`, an `Authorization:` line).
  A Kindgi key keeps its prefix and its last four characters.
- In a URL, the user and password become `[redacted]`, and so does each
  query value. The host and the path stay.
- An email address becomes `[email]`.
- A path inside the pack becomes relative (`./src/tool.ts`). Your home
  folder on its own becomes `~`. A path under your home folder, or under a
  system or user folder (`/Users`, `/home`, `/tmp`, `C:\`, …), becomes
  `[path]`. An API route like `/v1/secrets` stays.

Redaction can't catch everything in free text, a customer's or a host's
name for one. The preview is the check.

## What Kindgi keeps

- **Who reads them:** only Kindgi's maintainers, by hand.
- **For how long:** a report is kept 90 days from when it arrives, then
  deleted, [usually within a day](https://firebase.google.com/docs/firestore/ttl).
  Kindgi also keeps a count of the reports about the same issue, and what
  became of it, with none of a report's words. That lasts as long as the
  issue's newest report.
- **Your IP address:** the intake doesn't store it. Cloudflare carries
  every request to the intake, so it sees your address. Kindgi's request log
  at Cloudflare keeps it for up to 7 days, and Kindgi counts requests per
  address there for a minute, to limit them. Google Cloud, where the intake
  runs, logs only Cloudflare's address.
- **Deleting a report:** withdraw it, as below. Its text is cleared at once.

## Hear back

```sh
pnpm exec kindgi feedback status
```

It asks what became of the reports you sent, and answers with each one's
state:

| State | What it means |
| --- | --- |
| `received` | It arrived, and no one has triaged it yet. A report about an issue that's already fixed, or won't be, reads `received` until it's triaged again. |
| `known` | It's a known issue. The answer links the issue when it's public. |
| `fixed` | It's fixed, in the version the answer names. `FEEDBACK.md` marks the entry fixed. |
| `wont-fix` | It won't be fixed. The answer says why, in a line. |
| `withdrawn` | You took it back. |
| `unknown` | The intake doesn't have it: it never arrived, or its 90 days are over. |

It sends only the report ids. Unless you name a report, it asks about each
at most once a day. It never asks again about a report that's fixed, won't
be fixed or was withdrawn, and asks about one the intake doesn't have only
when you name it. Your coding agent runs it at the start of a
session when `FEEDBACK.md` has entries that were sent.

## Take a report back

```sh
pnpm exec kindgi feedback withdraw 2026-10-15.1
```

Name an entry by its id or hash, or a report by its id (`fbr_…`). The intake
clears the report's text and your machine's details at once. Until its 90
days are over, it keeps the report's id, its dates, and the issue it was
counted under.

Only the machine that sent a report can withdraw it, since its key is there.
In `FEEDBACK.md`, the entry stays, and its submitted line is marked
withdrawn. To send it again, name it: `kindgi feedback submit <id>`.

## Turn sending off

```sh
export KINDGI_FEEDBACK_SUBMIT=off
```

Then `kindgi feedback submit` sends nothing, `--preview` included, and exits
`1`. `kindgi feedback write` still records entries, and `status` and
`withdraw` still work. With `on`, or with the variable unset, it sends. Any
other value refuses as `off` does, so a typo never sends. The CLI reads it
from its environment: set it in your shell or your CI job, not in the
pack's env files.

All of the commands' options are in the
[CLI reference](../../reference/cli/feedback/).
