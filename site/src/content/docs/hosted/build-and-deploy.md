---
title: Build and deploy
description: Build your pack and deploy it to your Kindgi Cloud workspace with `kindgi deploy --hosted`, wait until its pack service is ready, then put its project in production.
sidebar:
  order: 10
---

On Kindgi Cloud, Kindgi builds your pack's image for you. `kindgi deploy
--hosted` sends the pack to Kindgi Cloud's build service, deploys what it
built, and waits until the deployment's pack service is ready. The image goes
to your workspace's own repository.

## Before you start

- **The Kindgi CLI, signed in to your workspace.** In the console, open
  **API keys** and **Create a key**. The secret shows once. In a terminal,
  paste it at a prompt that doesn't echo it, then sign in:

  ```sh
  read -rs KINDGI_API_TOKEN && export KINDGI_API_TOKEN
  kindgi auth login --url=https://platform.kindgi.com
  kindgi auth whoami
  ```

  `kindgi auth login` saves the key and the address in
  `~/.kindgi/config.json`. The CLI sends its key to the build service, and
  only there.
- **A signing key, trusted in your workspace.** The CLI signs what it
  deploys with a key of yours. Make one and trust it, once:

  ```sh
  kindgi key create acme-agency
  kindgi key trust acme-agency
  ```

  `kindgi key create` writes the private key to
  `~/.kindgi/keys/acme-agency.pem`, and `kindgi key trust` adds its public
  half to your workspace's trust list.
- **A pack that builds,** at most 30 MiB packed. A larger one isn't sent:
  the CLI says so and links
  [what the pack's image needs](../../start/existing-app-typescript/#what-the-packs-image-needs).

## Deploy

```sh
kindgi deploy --hosted --env=prod --signing-key ~/.kindgi/keys/acme-agency.pem
```

`--signing-key` names the key to sign with. The CLI doesn't look for one on
its own: with no key, or a path that isn't there, the deploy stops before
anything is built and says how to make one. `--env=prod` names your
workspace's environment, as on `kindgi secrets set`, so `--sync-secrets`
sends the values in `.env.prod`.

To leave out `--hosted` and `--signing-key`, give `prod` a block in
`kindgi.config.ts`. A pack made with `kindgi init` has it there, commented
out. With your key, it reads:

```ts
environments: {
  prod: {
    build: 'hosted',
    signingKey: '~/.kindgi/keys/acme-agency.pem',
  },
},
```

Then `kindgi deploy --env=prod` builds on Kindgi Cloud and deploys.

```text
CAPTURE: kindgi deploy --hosted, from the build to the pack service ready
```

- **No `endpoint`.** The deploy goes to the address you signed in to, and
  only there. An `endpoint` in the environment, or `--endpoint`, that names
  another address is refused, naming both.
- **The build** runs on the build service, and its log streams as it goes.
  When the stream is cut before the build ends, the CLI opens it again and
  prints each line once.
- **`--project <id-or-slug>`** deploys to that project: its id, or its
  slug. It's checked before anything is built, so a project that isn't there
  fails at once.
- **After the deploy,** the CLI waits up to 5 minutes for the deployment's
  pack service. It says each new state once (`pending`, and why), and ends
  when the pack service is ready. If the pack service is taken down before
  it's ready, the deploy fails:

  ```text
  CAPTURE: a deploy whose pack service was cleared before it was ready
  ```

- **`--from-envelope <path>`** deploys an envelope built earlier, without
  building.

## Build without deploying

```sh
kindgi build --hosted --env=prod --signing-key ~/.kindgi/keys/acme-agency.pem
```

Or `kindgi build --env=prod`, with the `prod` block above.

```text
CAPTURE: kindgi build --hosted
```

With `--project <id>`, the project is kept as a label on the build.
`--local`, `--endpoint` and `--registry-push-creds` don't go with
`--hosted`, and neither does `kindgi deploy`'s `--build-endpoint`.

## When the build service refuses

The CLI prints the build service's refusal with its status and code, and
the wait it asks for:

```text
CAPTURE: a build service refusal, as the CLI prints it
```

A `429` with `Retry-After` is waited out, and the same build sent again.

CAPTURE: the build service's refusal codes, each with what to do, from the
release candidate.

## Go live

A project's runs are staging until you put the project in production. From
then on they're production runs, your customers' real work. In the preview,
one project in production is free until Kindgi 1.0
([what the preview includes](../sign-up/#what-the-preview-includes)).

An admin of your workspace (in the console and the API, a tenant admin)
puts the project in production. In the console, use **Go live** on the
**Production** card of the project's **Dashboard**. With the CLI:

```sh
kindgi projects production <project-id> on
```

[Put a project in production](../../guides/projects/organize-by-org-and-project/#put-a-project-in-production)
has the rest: taking a project out, its status, and the SDKs.

- **Right after your workspace is made,** going live can take a moment to
  turn on. Until it does, the card says "Going live isn't on for this
  tenant yet. Building and testing work as they are.", and `on` is refused
  with `403 production-not-allowed`. If that's still so after a few minutes,
  write to contact@kindgi.com.
- **Your workspace's billing page** shows its plan, to its admins: "Your
  workspace is in the preview: hosting one live app is free until Kindgi
  1.0, within the hosted limits. We give 60 days' notice before any
  charge. For more than one live app, contact us." The card's links go
  there.
- **A second project** is refused with `403 production-limit-reached` while
  one is in production
  ([Projects in production](../limits/#projects-in-production)). For more
  than one live app, write to contact@kindgi.com.
