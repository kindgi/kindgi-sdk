---
"@kindgi/cli": patch
---

**A WooCommerce store connects with its owner's approval.** A pack made with `kindgi init --template=woocommerce` has a `connect-store` script: `pnpm connect-store https://shop.example.com` (`npm run connect-store …` where npm installs the pack) opens the store's wp-admin, where one of its administrators approves Kindgi on WordPress's own Authorize Application page. The script then makes the agent's own WordPress user, `kindgi-agent`, a Shop Manager, makes and checks its Application Password, saves `WOO_STORE_URL`, `WOO_USER` and the secret `WOO_APP_PASSWORD` in the pack's local env, and revokes the password WordPress made for the approval. Nobody copies a password, and none is printed, written to a file or put in a command's arguments. For a deployed pack, `--hosted --env=<env> --scope=project:<id>` saves them there; each pack and env gets its own password, so connecting `kindgi dev` and a deploy to one store keeps both. The README leads with it and keeps the manual steps, for a machine with no browser or a store whose approval page is off; they now name the user `kindgi-agent` too.

A starter's files other than its README can show the project's commands: `kindgi init` fills `{{RUN}}` (how the project runs a package.json script: `pnpm`, `npm run`), `{{KINDGI}}`, `{{INSTALL}}` and `{{TYPECHECK}}` in every file it renders from a template.
