---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**`kindgi init --template=drupal`: governed agents for a Drupal site.** The pack's agents use the site's own tools, through Drupal's MCP Server, signed in with OAuth client credentials (`scripts/connect-drupal.mjs` registers the endpoint; the client secret is a Kindgi secret).
- **`content-agent`** finds articles that break the house style and fixes them as drafts. Reading the site runs on its own; starting a draft and changing it each wait for a person (`default: 'always_ask'`, the read tools `never_ask` by id). The site's own permissions are the second layer: the agent's Drupal user can make drafts and can't publish or change a live article.
- **`content-review`**, a flow a Drupal webhook starts (`kindgi webhooks register --preset=drupal-webhooks`): a typed check step keeps the event's fields and house-style findings, not its copy of the text or the editor's account, and a `content-reviewer` that can only read the site writes a note for the editors.
- **The writes are chosen so a repeat is harmless** (a patch, a move to a workflow state; nothing created or deleted), since a retried or resumed call reaches the site again. The README says why, and how the Drupal side is set up, module by module.
