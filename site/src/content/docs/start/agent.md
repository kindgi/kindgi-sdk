---
title: Set up Kindgi with your coding agent
description: The steps a coding agent follows to take a person from nothing to a first agent that answers, with the person only signing in, copying two values and answering one question.
sidebar:
  order: 7
  label: Set up with a coding agent
---

This page is written for a coding agent (Claude Code, Cursor, Codex, or any
other). A person pastes this prompt into their agent:

```text
Set up Kindgi for me: read https://docs.kindgi.com/start/agent/ and follow it step by step. Tell me whenever you need me to do something, and wait for me.
```

If you are that agent: follow the steps below in order. Do everything you
can yourself. Ask the person only for what the steps say needs them, one
thing at a time, and wait until they say they've done it.

If your fetch tool cut this page short, read it from
<https://docs.kindgi.com/_llms-txt/start.txt>: the Start section as plain
text, with this page under "Set up Kindgi with your coding agent".

## Rules for the whole setup

- **Never let a secret into the chat or into your context.** The pull token
  and the model key go from the person's clipboard straight into a command
  through a pipe. Never print, log, echo or save them anywhere else, and
  never ask the person to paste one into the chat.
- **If a pipe from the clipboard doesn't work,** ask the person to run the
  command themselves, in their own terminal, without `--password-stdin` or
  `--from-stdin`: it then asks for the value without showing it.
- **When something fails, run doctor** (below) and read what it says before
  you guess.
- **`kindgi` in the commands below** means, until step 2 makes a project:
  `npx --yes @kindgi/cli@0.1` if `node --version` works; else, for someone
  using Python without Node, `uvx --from "kindgi-cli>=0.1,<0.2" kindgi`
  (the CLI from PyPI; it needs no Node). From step 2 on, from the project's
  folder:
  - a TypeScript project: `pnpm exec kindgi` if `pnpm --version` works,
    else `npx --no kindgi`;
  - a Python project: `uv run kindgi` (the project's dev dependencies bring
    the CLI);
  - a Java or Scala project: `./kindgiw` (the CLI version the project pins in
    `kindgi.config.json`; `kindgiw.cmd` on Windows).

## Step 0: check the machine

Work out the clipboard command for this OS:

| OS | Read the clipboard | Clear it |
| --- | --- | --- |
| macOS | `pbpaste` | `pbcopy < /dev/null` |
| Linux (Wayland) | `wl-paste --no-newline` | `wl-copy --clear` |
| Linux (X11) | `xclip -o -selection clipboard` | `xclip -selection clipboard < /dev/null` |
| Windows | use the fallback below | |

Before you pipe the clipboard, check it isn't empty, without printing it:
`[ -n "$(pbpaste)" ]` (with this OS's command). If the clipboard command
fails (on a server, over SSH or in a container there's no clipboard) or the
clipboard is empty, use the fallback: the person runs the command in their
own terminal, where it asks for the value without showing it. On Windows,
always use the fallback.

Then run doctor:

```sh
kindgi doctor --json
```

It prints one JSON object and exits `0` when nothing fails, `1` when a check
fails (and `2` on a usage error). Here, in a project with `kindgi dev`
running and no model key yet:

```json
{
  "ok": false,
  "cliVersion": "0.1.4",
  "project": { "dir": "/Users/you/my-agents", "language": "node" },
  "checks": [
    {"id": "node", "status": "pass", "message": "Node 22.21.1."},
    …,
    {"id": "model-key", "status": "fail", "message": "No model key in .env or .env.local (looked for ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY).", "fix": "With kindgi dev running, set one LLM provider's key: pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant, or the same with GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY (it prompts without echoing; or pipe it in with --from-stdin). Never paste a key into a chat."},
    {"id": "runtime", "status": "pass", "message": "The runtime answers at http://127.0.0.1:63421."},
    {"id": "provider", "status": "fail", "message": "Only dev-echo is registered: agents get its canned replies, not a model's.", "fix": "Register the provider whose key you set: pnpm exec kindgi providers register --preset=<preset>, where <preset> is anthropic, gemini-api, groq, openai or openrouter (see Model key)."}
  ]
}
```

The checks come in this order: `node`, `npm`, `python`, `uv`, `java`,
`maven`, `sbt`, `docker`, `registry`, `dev-sandbox`, `console-sign-in`, `project`,
`dependencies`, `model-key`,
`runtime`, `provider`.

- **`fail`:** run its `fix`, as written: it names the CLI to use in that
  folder. When the fix needs the person (start Docker Desktop, sign in, copy
  a key), ask them, then run doctor again.
- **`warn`:** it works now, but the person should know: tell them its
  `message` and `fix`, and go on. `ok` stays `true` and the exit code `0`.
  In this release three checks warn. `dev-sandbox`: when `kindgi dev` can't
  run the pack's code sandboxed on this machine (Linux without bubblewrap,
  a container, Windows, or inside another sandbox); the code would then run
  with the person's own access. `provider`: when an agent that names no
  model would get a model the preset no longer lists, or one other than the
  preset's default; or when the runtime can't build a registered provider
  (each problem is in the check's `details`). When it can build none,
  `provider` fails instead. `console-sign-in`: when nobody can sign in to the
  console of the runtime the CLI points at.
- **`skip`:** not applicable yet. Outside a project, `project` and every
  check after it skip; `runtime` skips while `kindgi dev` isn't running;
  `dev-sandbox` skips when `KINDGI_DEV_SANDBOX=off`.

Fix every `fail` up to and including `docker` before you go on. `registry` is
step 1.

## Step 1: access to the runtime image

If doctor's `registry` check passes, this machine can already pull the
runtime: skip this step.

1. Ask the person for the runtime image's pull credentials, a robot name
   and a pull token: "Copy your Kindgi pull token, and tell me when you're
   done. Also tell me your robot name (it isn't secret)." The image is in
   private preview: someone without credentials requests access at
   contact@kindgi.com, and you stop here until they have them.
2. When they say they're done, pipe the clipboard into the login, with the
   robot name they gave you:

   ```sh
   <read the clipboard> | kindgi auth registry --username <robot name> --password-stdin
   ```

3. Clear the clipboard, if this OS lets you.
4. Run doctor again; `registry` should pass.

## Step 2: the project

1. Ask the person for a name for their project, or use `my-agents`. Use
   TypeScript if doctor's `node` check passes and the person has no
   preference; Python if they ask for it, or if there's no Node (doctor's
   `python` and `uv` say whether it's ready); Java if they ask for it
   (doctor's `java` says whether there's a JDK 17 or later; Maven comes with
   the project); Scala if they ask for it (a JDK 17 or later too, and
   doctor's `sbt` says whether sbt is installed).
2. Create it and install its dependencies:

   ```sh
   # TypeScript
   npx --yes @kindgi/cli@0.1 init my-agents
   cd my-agents
   pnpm install     # if pnpm --version works; else: npm install
   ```

   ```sh
   # Python (no Node needed)
   uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-agents --template=python
   cd my-agents
   uv sync          # brings the CLI too: from now on, uv run kindgi …
   ```

   ```sh
   # Java (preview)
   npx --yes @kindgi/cli@0.1 init my-agents --template=java   # from now on: ./kindgiw …
   cd my-agents
   ./mvnw -q test
   ```

   ```sh
   # Scala (preview)
   npx --yes @kindgi/cli@0.1 init my-agents --template=scala   # from now on: ./kindgiw …
   cd my-agents
   sbt -batch test
   ```

3. Run doctor again from the project's folder; `project` and
   `dependencies` should pass.

`init` also gives you Kindgi's skills, in `.claude/skills/`, for the
project's language (a Java or Scala project gets its own). Read them: they
are how you write tools and agents for this project.

## Step 3: start Kindgi

Start `kindgi dev` from the project's folder so that it keeps running after
your turn ends: detached, with its output in a log, and note its process id:

```sh
mkdir -p .kindgi
nohup kindgi dev > .kindgi/dev.log 2>&1 &
echo $!
```

Use `kindgi` as the project runs it (`.kindgi/` is git-ignored). Keep
`mkdir` on its own line: with `mkdir … && nohup … &`, `$!` is a subshell's
id, and stopping it leaves `kindgi dev` running. It starts the runtime in
Docker and answers with a stand-in model, `dev-echo`, until step 4 adds a
real one.

Run doctor every few seconds until `runtime` passes. `model-key` and
`provider` still fail: that's expected until step 4. Then tell the person
it's running, and how to stop it: `kill <the process id>`. Also tell them
where the console is: the `Console` line of `.kindgi/dev.log`, its first
address (`kindgi doctor --json` has it as `consoleUrl`, and `kindgi console`
opens it in their browser). They sign in there with **Sign in as seeded
user**, which needs no token: don't print the token in the chat. Tell them
to use Chrome or Firefox: Safari can't keep the local sign-in over http yet
([Known limitations](../../deploy/operate/#known-limitations-in-015)).

## Step 4: the model key

1. Ask the person: "Which model provider do you have an API key for:
   Anthropic, OpenAI, Gemini, Groq or OpenRouter? Copy that key, tell me the
   provider, and tell me when you're done." Each provider has its key's name
   and a preset:

   | Provider | Key | Preset |
   | --- | --- | --- |
   | Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
   | OpenAI | `OPENAI_API_KEY` | `openai` |
   | Gemini (a Google AI Studio key) | `GEMINI_API_KEY` | `gemini-api` |
   | Groq | `GROQ_API_KEY` | `groq` |
   | OpenRouter (a hosted gateway) | `OPENROUTER_API_KEY` | `openrouter` |

   **If they have no key, or don't want to add one now,** stop here,
   honestly: Kindgi is running with its stand-in model, `dev-echo`, which
   only repeats what it gets, and says so: its answers start with
   `⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers.`
   Adding a key (this step) gives a real answer. Don't write a tool that
   passes text through, or anything else that makes `dev-echo`'s reply look
   like an agent's answer.
2. When they say they're done, pipe the clipboard into the project's
   secrets under that provider's key, then register its preset. For
   OpenAI:

   ```sh
   <read the clipboard> | kindgi secrets set OPENAI_API_KEY --env=local --scope=tenant --from-stdin
   kindgi providers register --preset=openai
   ```

   `secrets set` writes the key to the project's `.env.local`, which git
   ignores. It needs `kindgi dev` running. `kindgi providers presets` lists
   the presets and their models.
3. Clear the clipboard, if this OS lets you.
4. Run doctor again; `model-key` and `provider` should pass.

Doctor's `model-key` only checks that a key is saved: a wrong key shows as a
`401` on the first run. Then don't open, measure or print `.env.local`. Ask
the person to copy the key again (they can check it in their provider's
console), and run the
`secrets set` command again with `--write-mode=add-version`: without it, a
key that's already stored is refused (`Version conflict: OPENAI_API_KEY
already exists`). The new key is used from the next run: there's no need to
register the provider again or to restart `kindgi dev`.

## Step 5: the first agent

1. Ask the person: "What's one thing you'd like an agent to do?" If they
   don't know, suggest: "Read a customer message and say how urgent it is,
   and why."
2. Write that agent in the project, following the skills in
   `.claude/skills/`. `kindgi dev` picks up the file when you save it.
3. Run it with an example the person would recognise, and show them the
   answer:

   ```sh
   kindgi runs start --agent=<pack id>.<agent name> --input='{"userMessage":"…"}'
   ```

   It waits for the run and prints it; the answer is in its `output`.

## Step 6: wrap up

Tell the person, in your own words:

> **Your first agent answered.** It runs on your machine, with your model
> key in `.env.local`; Kindgi keeps running in the background until you stop
> it with `kill <the process id>`. Three things to try next:
>
> 1. **Give it a tool:** ask me "add a tool that looks up an order, and let
>    the agent call it".
> 2. **Judge a few answers:** say yes or no to what it answered, so later
>    versions can be checked against your judgments
>    ([Judge a run's output](https://docs.kindgi.com/guides/evals/judge-a-runs-output/)).
> 3. **Compare two versions:** change its instructions and see whether people's
>    judgments rate the new version higher
>    ([Compare a version on a test set](https://docs.kindgi.com/guides/evals/compare-an-agent-version/)).
