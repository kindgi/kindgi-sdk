# @kindgi/bounds

The limits a Kindgi server puts on what a tenant sends it, so that one
tenant's input can't stall the server for the others:

- **patterns:** their length, the engine they run on (V8's, or RE2's,
  which runs in linear time, so no pattern can take exponential time), and
  how many citations a `must-cite` guardrail may ask for;
- **schemas:** their size and nesting depth before they're compiled, how
  many compiled ones are kept and how much JSON they add up to, and how
  long a tenant's schemas may spend compiling in any 60 seconds;
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

## Whose work it is

A budget kept per tenant (`schemaCompileBudgetMs`) charges the tenant
whose work is running. The server runs each request and each run inside
`runAsTenant(tenantId, fn)`; `currentTenant()` reads it. The scope follows
`fn`'s own awaits and callbacks (an `AsyncLocalStorage` context), never
another request's. Outside any scope, at boot or in Kindgi's own work,
nothing is charged.

Which compiles count is the scope's `compiles`:

- `recompiles`, the default: a schema compiled again after the cache
  dropped it. The first compile of a schema the tenant published doesn't
  count, so a restarted server compiles each tenant's schemas freely.
  Once a tenant has compiled 4,096 different schemas in the process, every
  compile counts.
- `all`: every compile, the first included. A request that publishes,
  deploys or registers schemas runs this way, since that's where new
  schemas come from.

```ts
import { runAsTenant } from '@kindgi/bounds';

await runAsTenant(tenantId, () => handle(request));
await runAsTenant(tenantId, () => publish(request), { compiles: 'all' });
```

Work that runs on another thread, such as a template rendered in a worker,
is charged with `TenantTimeBudget.admit(tenantId)`. It checks the budget
when the work is asked for, refusing a tenant past it, and returns a
`TenantWork` whose `start()` and `end()` charge the time between them.
Time the work spends waiting for a thread isn't charged.

## Patterns

`compileTenantPattern(source, flags)` compiles a pattern a tenant wrote, a
JavaScript regular expression's source and flags, under the process's
bounds. It answers `{ kind: 'ok', pattern }`, whose `test(input)` and
`count(input, atMost)` give the answers of the `RegExp` it was written as
(on RE2, but for the differences below), or `{ kind: 'refused', reason }`,
saying why.

```ts
import { compileTenantPattern } from '@kindgi/bounds';

const compiled = compileTenantPattern(config.pattern, config.flags);
if (compiled.kind === 'refused') throw new Error(`config.pattern: ${compiled.reason}`);
compiled.pattern.test(output);
compiled.pattern.count(output, 3); // stops at 3
```

With `SELF_HOSTED_BOUNDS` a pattern runs on V8's engine, as `new RegExp`
does, up to 8,192 characters with its flags. With `HOSTED_BOUNDS` it runs on
[RE2](https://github.com/google/re2/wiki/Syntax) (the
[re2js](https://www.npmjs.com/package/re2js) port), in time linear in its
input, up to 1,024 characters. On RE2:

- **Only what `RegExp` accepts:** a pattern V8 refuses is refused in V8's
  words, even where RE2 would compile it (`(?i)`, `(?P<n>…)`, or with `u`,
  `\pL` and `\x{41}`).
- **Refused, by name:**
  - what RE2 doesn't have: backreferences (`\1`, `\k<name>`), lookahead and
    lookbehind (`(?=`, `(?!`, `(?<=`, `(?<!`), and `\u` escapes (write the
    character itself);
  - what RE2 would silently read otherwise: `[]` and `[^]` (the start of a
    class to RE2), `[:` in a class (a POSIX class to RE2) and, without the
    `u` flag, `\p`, `\P`, `\A`, `\z`, `\Q`, `\a` and `\x{`, in a class or
    out, which JavaScript reads as the letter itself.
- **Refused in RE2's words:** anything else RE2 can't compile, such as a
  repeat count over 1,000.
- **Flags:** `i`, `m`, `s` and `u` map to RE2's own; `y` anchors at the
  start; `g` and `d` change no answer; `v` is refused.
- **Read differently, for every pattern:**
  - RE2 always matches by code point and folds case as the `u` flag does: `.`
    matches an emoji, and `/ſ/i` matches `s`;
  - `.` stops only at `\n`, not at `\r`, `\u2028` or `\u2029`, and with `m`, `^`
    and `$` match only around `\n`;
  - `\s` is ASCII whitespace (`\t`, `\n`, `\f`, `\r` and space).
- **Counting:** every match of a pattern like `x.*y|x` can read to the end of
  the input, so counting them all is quadratic. `count(input, atMost)` scans
  at most `atMost` matches, each linear in the input, so it costs up to
  `atMost` × the input. A `must-cite` guardrail asks for its `minCitations`, at
  most `mustCiteMaxCitations`: 100 with `HOSTED_BOUNDS`, no cap with
  `SELF_HOSTED_BOUNDS`.

Apache-2.0.
