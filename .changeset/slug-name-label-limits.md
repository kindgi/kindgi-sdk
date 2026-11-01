---
"@kindgi/types": patch
"@kindgi/api": patch
---

**Slugs, names, labels and titles have one rule, on create and on update.** `@kindgi/types` exports the slug rule the API, the CLI and the console all check: `SLUG` (lowercase letters, digits and hyphens, starting with a letter or digit, at most `SLUG_MAX`, 63 characters), `SLUG_RULE` (that rule in words), `isSlug`, `slugOf`, and a workspace's own `TENANT_SLUG`, `TENANT_SLUG_MAX` and `isTenantSlug`.

The API answers `400 bad-input` where it used to take the value:

- an org's, a project's or a team's slug that doesn't match `SLUG`, on create and on update. The CLI and the console already keep to this rule, so only a direct API caller sees the change;
- a name of more than 100 characters, or a blank one, for an org, a project or a team, on create and on update. An update with `name: ""` or `slug: ""` is refused too;
- an API key's label, or a schedule's, a mail trigger's, an event trigger's or a webhook trigger's, that is blank, isn't a string, or has more than 100 characters. A trigger's create used to drop such a label without a word, and its update stored any value sent; `null` still clears a trigger's label on update;
- a conversation title of more than 200 characters. A blank or absent one is still "Untitled conversation".

Characters are counted as code points, as JSON Schema's `maxLength` counts them: a character outside the Basic Multilingual Plane is one, not two. A workspace's name, a system key's label and a tenant's suspend reason now count the same way, which only loosens them.

A value stored before its rule applied stays, and reads as before. An update that sends it back unchanged passes, and leaves it as it is, so a client that reads a row and writes it back keeps working.

The OpenAPI carries the slug pattern and the limits on the create bodies, so the Python and Java clients refuse those values before they send them. The update bodies say the rules in their descriptions instead, and lose their `minLength: 1`, so neither client refuses a stored value sent back unchanged.
