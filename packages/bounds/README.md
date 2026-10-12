# @kindgi/bounds

The limits a Kindgi server puts on what a tenant sends it, so that one
tenant's input can't stall the server for the others:

- **patterns:** their length, and the engine they run on (V8's, or RE2's,
  which runs in linear time, so no pattern can take exponential time);
- **schemas:** their size and nesting depth before they're compiled, and how
  many compiled ones are kept;
- **templates:** liquidjs's parse, render-time and memory limits;
- **bodies** read from endpoints a tenant names: their size, decompressed,
  and the idle time between chunks (per event for `text/event-stream`);
- **request bodies** the API reads: their size and JSON nesting depth.

The process sets its bounds once, at boot. The Kindgi runtime sets
`HOSTED_BOUNDS` under its hosted profile; anywhere else it's
`SELF_HOSTED_BOUNDS`, today's behaviour with generous caps. A second call
throws.

```ts
import { HOSTED_BOUNDS, configureTenantInputBounds, tenantInputBounds } from '@kindgi/bounds';

configureTenantInputBounds(HOSTED_BOUNDS); // once, at boot
tenantInputBounds().schemaMaxBytes;          // what the helpers read
```

Tests run with other bounds through `@kindgi/bounds/testing`'s
`overrideTenantInputBounds`, which returns the function that puts them back.

Apache-2.0.
