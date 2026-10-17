---
'@kindgi/client': patch
'@kindgi/cli': patch
---

A webhook or schedule trigger can run as a **service account**. A trigger's runs act as its owner; now the owner can be an account rather than whoever registered it. Pass `runAsServiceAccountId` when registering (`webhooks.register`, `schedules.register`) or when taking over a trigger whose owner left (`webhooks.takeOwnership`, `schedules.takeOwnership`), or `--run-as <service-account-id>` on `kindgi webhooks register`, `kindgi schedules create` and the `take-ownership` commands. Naming an account needs `act_as` on it. Only a caller who may read service accounts learns whether a named one is missing, unregistered or not `act_as`-able; everyone else gets a uniform permission error.
