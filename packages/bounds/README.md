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

## Patterns

`compileTenantPattern(source, flags)` compiles a pattern a tenant wrote, a
JavaScript regular expression's source and flags, under the process's
bounds. It answers `{ kind: 'ok', pattern }`, whose `test(input)` and
`count(input, atMost)` give the answers of the `RegExp` it was written as,
or `{ kind: 'refused', reason }`, saying why.

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

- **Refused, by name:** backreferences (`\1`, `\k<name>`), lookahead and
  lookbehind (`(?=`, `(?!`, `(?<=`, `(?<!`), and what RE2 would silently read
  otherwise: `[]` and `[^]` (the start of a class to RE2) and `[:` in a class
  (a POSIX class to RE2). So is anything RE2 can't compile, in RE2's words,
  such as a repeat count over 1,000.
- **Flags:** `i`, `m`, `s` and `u` map to RE2's own; `y` anchors at the
  start; `g` and `d` change no answer; `v` is refused.
- **Read differently, for every pattern:**
  - RE2 always matches by code point and folds case as the `u` flag does: `.`
    matches an emoji, and `/ſ/i` matches `s`;
  - `.` stops only at `\n`, not at `\r`, `\u2028` or `\u2029`, and with `m`, `^`
    and `$` match only around `\n`;
  - `\s` is ASCII whitespace (`\t`, `\n`, `\f`, `\r` and space).

Apache-2.0.
