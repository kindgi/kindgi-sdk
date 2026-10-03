---
"@kindgi/cli": patch
---

**A new pack gets its `.gitignore` again.** `npx @kindgi/cli init` wrote no `.gitignore`: npm renames a package's `.gitignore` to `.npmignore` when it installs it, so the templates' file never reached the new pack, and `.env` (model keys) and `.kindgirc.json` (the dev token) weren't ignored by git. The templates now store it as `gitignore`, and `init` writes it as `.gitignore`. If you created a pack with 0.1.0, add a `.gitignore` with at least `.env`, `.env.local`, `.kindgirc.json` and `.kindgi/`. Adding Kindgi to an existing app was not affected.
