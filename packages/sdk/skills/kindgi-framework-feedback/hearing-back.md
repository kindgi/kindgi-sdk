# Hearing back, and taking one back

## Hearing back

At the start of a session, when `FEEDBACK.md` has submitted entries, run
`kindgi feedback status`. It asks about each report at most once a day,
and never again once it's fixed, won't be fixed, or was withdrawn, or once
the intake doesn't have it (past its 90 days) unless it's named. A fixed
entry gets `> **Fixed:** in <version> (report fbr_…)` under its heading.
Tell the person what changed:
- **fixed**, with the version: suggest upgrading to it;
- **known**, with the public issue when there is one;
- **won't fix**, with the one-line reason.

Name an entry or a report id (`kindgi feedback status 2026-09-25.3`) to
ask about it now. A teammate's report id works too: it isn't a secret.

## Taking one back

When the person asks to withdraw a report, run
`kindgi feedback withdraw <id|hash|reportId>`. The intake clears its text
at once, and the entry's line gets `· **withdrawn:** <date>`. It needs the
key on the machine that sent the report. A withdrawn entry isn't sent again
unless the person names it in `submit`.
