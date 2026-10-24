---
"@kindgi/schema": patch
---

**Under `HOSTED_BOUNDS`, a schema with a format bound compiles and is checked, as under `SELF_HOSTED_BOUNDS`.** The Ajv that `compileJsonSchema`, `compileInlineSchema` and `createSpecRegistry` make on RE2 left out `formatMinimum`, `formatMaximum`, `formatExclusiveMinimum` and `formatExclusiveMaximum`. So in strict mode a schema such as `{ "type": "string", "format": "date", "formatMinimum": "2020-01-01" }` was refused for an unknown keyword, and without strict mode its bound was ignored. The four are there now. They compare `date`, `time`, `date-time`, `iso-time` and `iso-date-time` values as under `SELF_HOSTED_BOUNDS`, in time linear in the value.
