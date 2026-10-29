# Sending it to Kindgi: only with the person's yes

`FEEDBACK.md` stays in the pack until the person decides to send it.
`kindgi feedback submit` sends entries to Kindgi's private intake on
access.kindgi.com. Only Kindgi's maintainers read reports there. They're
kept 90 days, and the person can take one back at any time.

**Never send on your own.** Every time:

1. **Preview.** Run `kindgi feedback submit --preview`, or name entries by
   id or hash: `kindgi feedback submit 2026-09-25.3 --preview`. With none
   named it takes every entry not sent yet and not marked fixed. It prints
   exactly what would be sent, after redaction, and its `digest`. Nothing
   is sent.
2. **Show the person.** Show them each entry's title and body as they'll
   go, and the environment sent with them: the OS, Node and CLI versions,
   the pack's language, and `kindgi doctor`'s checks as id and status
   only. Point out anything redaction missed, like a customer's name or an
   internal host name. If something shouldn't go, edit the entry in
   `FEEDBACK.md` and preview again.
3. **Ask, then send.** Ask "Send this to Kindgi?" Only after a clear yes,
   run the same command with `--yes=<digest>` in place of `--preview`. If
   anything changed since the preview, it refuses: preview and ask again.

If `submit` says "Kindgi may have received it" (the answer was lost, came
too late, or couldn't be read), tell the person, and don't send again on
your own: a second send makes a second report, and one that arrived can't
be withdrawn from this machine. Let them decide.

What redaction takes out before the preview:
- the home directory alone becomes `~`, and paths in the pack become `./…`;
- other absolute paths become `[path]`, a path under `~` too;
- values from the pack's `.env*` files and `.kindgi/secrets.env` become
  `[redacted]`;
- private keys and token shapes become `[redacted]` (a Kindgi token keeps
  its prefix and last four characters);
- a URL keeps its host and path but loses its user info and query values;
- email addresses become `[email]`.

It can't catch everything in free text: the preview is the check.

Once sent, each entry gets a line like
`- **submitted:** 2026-09-25T15:02:11.000Z · **report:** fbr_…`. The
report id isn't a secret, so `FEEDBACK.md` can still be committed. The key
that takes a report back is kept in `~/.kindgi/feedback/keys.json` on this
machine and is never printed. Don't read or copy that file.

If `KINDGI_FEEDBACK_SUBMIT=off` is set, `submit` refuses. That's the
person's or their team's choice, so don't work around it. `write`,
`status` and `withdraw` still work.
