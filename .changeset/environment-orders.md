---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/cli": patch
---

**Environment orders — the order a tenant runs a project through on its way to live.** One ordered list of projects per parent: the tenant, or one of its orgs.
- **`GET /v1/environment-orders`** lists the orders the caller can read a project in; **`GET /v1/environment-orders/tenant`** and **`/orgs/{orgId}`** read one (empty when it was never set or was cleared). A project the caller can't read is named by its position alone, without its id — the same project-read check `GET /v1/projects` filters its list with.
- **`PUT /v1/environment-orders/tenant`** and **`/orgs/{orgId}`** replace an order with the projects given, in order; send `[]` to clear it. For a tenant admin; an org admin or a project admin is refused, even on an org's own order. An order needs two or more projects, no project named twice, and each project live in the tenant under that parent and in no other order (`409 project-in-another-order`). A write that changes nothing is a no-op.
- A new optional `environmentOrders` binding (`EnvironmentOrderBinding`) backs the routes; a runtime that doesn't wire it doesn't mount them. The host application supplies it — `@kindgi/api` never constructs one.
- The TypeScript and Python clients reach them through `client.environmentOrders`.
- **`kindgi environments`** lists an order (`list`), sets it (`set`, naming environments from the pack config's new optional `environments.<name>.project`, or `--projects` ids/slugs), and clears it (`clear`). `kindgi env` is reworded to name a value set, to tell the two apart.
- A signed, exportable `environment-order-set` audit event records each set, with the order before and after — never anything a project holds.
