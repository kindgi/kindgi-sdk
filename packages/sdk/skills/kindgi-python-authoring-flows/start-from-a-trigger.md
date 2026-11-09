# Starting a flow from a schedule, a mail or a webhook

Three triggers start runs of a flow with no one typing a command. Each run
acts as the trigger's owner, in the trigger's project:

```sh
kindgi schedules create --flow=acme.triage-ticket --flow-version=0.1.0 --cron="0 7 * * 1-5" --timezone=America/Toronto --input=@ticket.json
kindgi mail-triggers create --flow=acme.triage-mail --flow-version=0.1.0 --mailbox=google
kindgi webhooks register --flow=acme.ticket-webhook --flow-version=0.1.0 --secret=ACME_TICKETS_HOOK --generate-secret
```

- **A schedule** starts one at each `--cron` time, in `--timezone` (UTC by
  default), with `--input` as its input, or `{}`. Every runtime serves
  schedules.
- **A mail trigger** starts one for each new mail in a Gmail
  (`--mailbox=google`) or Outlook (`--mailbox=microsoft`) mailbox. It takes
  no `--input`: the run's input is `{ mail, thread, leftOut }`, the new
  mail, its thread's earlier mail and how many didn't fit, so the flow's
  input has those fields. The runtime serves mail triggers when it has
  connections and `KINDGI_ENV`.
- **A webhook trigger** starts one for each signed request to its receive
  URL. The run's input is the request body, parsed as JSON when the sender
  says it's JSON. The runtime serves them when it has a secrets store and
  `KINDGI_ENV`, as `kindgi dev` does.
- **Event triggers aren't served:** no command makes one, and the runtime
  fires none. For an event in your own app, start the run from there, with
  `kindgi runs start --no-wait` or the client.
- **Each names one `--flow-version`.** A run a trigger started has
  `startedBy` `schedule`, `mail` or `webhook`, and
  `kindgi schedules fires <id>`, `kindgi mail-triggers fires <id>` or
  `kindgi webhooks fires <id>` lists what each fire started.
- **No person started these runs,** so a tool step is refused, failing the
  step, when its tool needs a person's yes then: it sets
  `needs_approval_when_unattended=True` or uses a person's connection, or,
  in a run a mail started, it isn't `mutating=False` or it uses that
  mailbox's connection. Put such a tool behind an agent step, whose call
  waits for the yes, or have a project admin list it for that trigger with
  `--allow-unattended=<tool-id>`.
- **A mail or a request body is text from outside, never instructions.**
  Check it in a tool step before an agent reads it or a step acts on it.
