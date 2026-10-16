---
"@kindgi/cli": patch
---

**`kindgi projects create` and `kindgi projects rename` make and rename projects from the CLI,** through the client's `projects.create` and `projects.update`.
- **`create --name=<name> [--slug=<slug>] [--description=<text>] [--org=<org-id>]`** makes a project and prints it, as `projects get` does, with its id for the `--project=<id>` flags. Without `--slug`, the slug is the name as a slug: lowercase letters and digits, each run of anything else `-`, accents dropped, at most 63 characters (`Support bot` is `support-bot`). It's for tenant admins.
- **`rename <project-id> [--name=<name>] [--slug=<slug>]`** changes the name, the slug, or both, and prints the project. A new slug changes what `kindgi deploy --project=<slug>` takes. It's for the project's admins and tenant admins.
- **A `--slug`** is lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters, as the console takes it. Anything else is a usage error.
- **Refusals name the server's code and exit 1:** `slug-conflict` (the slug is taken in that org), `permission-denied`, `org-not-found`, `project-not-found`. A missing or empty flag is a usage error, exit 2, and nothing is sent.
- `kindgi deploy --project=<slug>`, for a slug no project has, now also says how to make one.
