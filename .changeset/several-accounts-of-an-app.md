---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/tools": patch
"@kindgi/runtime": patch
"@kindgi/connections-inmemory": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**One agent can use several accounts of one app: the company's, or a person's own.**

A person can connect an app more than once. One of their connections through a registration in an environment is their main (`Connection.main`, `ConnectionCandidate.main`): the one their agents use when no choice names another. A person's first connection has no main. Their second connect makes the first one their main, and the connect finish says which (`main`: `set`, `kept` or `missing`, with `connectionId` for the first two). `PATCH /v1/connections/{connectionId}` with `{ "main": true }` makes a connection its owner's main, in place of the one that was. Only that person can do this; the company's connections have no main, and `main: false` is refused, since a main moves only when another is made main. A mail trigger's stored connection doesn't move with it.

A choice can now be for one tool's connection, not only for an agent's or a flow's app: `toolId` and `need`, the tool's name for the connection, which may be left out when the tool uses the app once. A choice can also be a person's own (`person`), for their own runs: only they make, change or remove it. For a tool that changes nothing, a choice can be a set (`connectionIds`): 2 to 10 candidates, each named, with `connectionId` among them as the one a call that names none uses. The agent's model then sees an `accounts` input on that tool. That input names, by connection name, which of the set's connections a call reads; the model never sees connection ids. A name outside the set fails the call with `connection-missing`. A tool that changes things, declares `sensitive-data-egress` or has an `accounts` input of its own can't take a set.

- `GET /v1/connection-choices/needs` lists an agent's or a flow's tools' connections at the versions they resolve to now: the tool, its `need`, the app, whose connection it is (`as`), and whether a choice for it may be a set (`set.allowed`, else `set.reason`: `changes`, `sensitive-data-egress` or `accounts-input`). Tools whose version couldn't be read are in `unread`.
- `GET /v1/connections/{connectionId}/choices` lists the live choices that name a connection, as `connectionId` or in a set, for its owner or a tenant admin.
- `GET /v1/connection-choices` takes `toolId`. It lists the company's choices and the caller's own, and a tenant admin reads every person's too; `owner=me` lists only the caller's own. `GET /v1/connection-choices/candidates` takes `owner=me` for the caller's own connections.
- A run's record of the connection a call used says how it was picked (`by`: `named` or `main` are new), whose it was (`as`), and for a set, how many it had (`setSize`), without naming the others. A person's connection on that record now carries only its account's id, not its label.
- An approval's connection (`ApprovalConnection`, and `HitlEnqueueInput.connection`) gains `as`. A person's account isn't named there any more, and `account` is optional: the reviewer sees "this person's <app> account". Approvals recorded before keep what they had.
- A mail trigger on a person's mailbox can name its owner's own connection (`config.mailbox.connectionId`). With none named it stores their main, else their only one; several and no main is `409 connection-not-chosen`, counting them and naming none. A person mailbox's `account` (its address) is read only by the trigger's owner and a tenant admin; anyone else reads the trigger without it. A take-over of a person's mailbox clears its stored connection and its `account` label until the next poll.

- `@kindgi/api`: the routes above, and `ConnectionBinding` gains `choiceNeeds` and `listChoicesForConnection`, with `main`, `toolId`, `need`, `connectionIds`, `person` and `owners` on its inputs and records. New types: `ConnectFinishMain`, `ConnectionChoiceNeedRecord`, `ConnectionChoiceNeeds` and `ConnectionSetRefusal`. For tests, `@kindgi/api/testing`'s trigger registry gains `recordPoll`, which records a mail trigger's poll and the account it read.
- `@kindgi/tools`: `ResolveConnectionsInput.accounts`, a need's connection id named by the call; `ConnectionResolver.accountChoices`, the sets a turn offers, with the types `ConnectionAccountChoices` and `ConnectionAccountChoicesInput`; and `ConnectionPick`'s new `by` values, `as` and `setSize`.
- `@kindgi/agents`: a turn asks the resolver for its sets once, offers each as an `accounts` input, and takes it off the arguments before the tool runs. `connectionSetRefusal(tool)` is the one rule for which tools may take a set.
- `@kindgi/runtime`: `MailTriggerRecord.account`'s label is optional, and the scheduler's docs cover a person mailbox's connection.
- `@kindgi/connections-inmemory`: keeps mains, tool choices, person choices and sets the same way, and its resolver picks a call's connection in the same order.
- `@kindgi/client`: `client.connectionChoices.needs(...)`, which answers a `ConnectionChoiceNeeds`, `client.connections.choices(connectionId)`, and the new fields and queries above.
- `@kindgi/cli`: `kindgi connection-choices set` takes `--tool`, `--need`, `--default` and `--mine`, and `list` takes `--tool` and `--mine`, with TOOL, NEED and CONNECTIONS columns. `kindgi connections update --main` makes a connection your main, and `kindgi connections list` marks it `(main)`. After a person's new connection, `connect` says which of theirs their agents use when they have several there: their main, or that none is, so a call that needs one stops with `connection-not-chosen` until one is. `kindgi mail-triggers` takes `--connection` with `--as=person`: your own connection that reads your mailbox. A person's mailbox's `connection-not-chosen` says how to name one, or make one main.
