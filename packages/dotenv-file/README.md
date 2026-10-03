# @kindgi/dotenv-file

Dotenv files the way applications read them, written the way people edit
them. Zero runtime dependencies, no filesystem access — you read and write
the files; this package parses, expands, layers and edits their text.

Kindgi often lives inside an existing application and shares its `.env`
files. When both read the same file they must see the same values, and when
Kindgi writes a key it must not disturb anything else in the file. This
package is where that guarantee lives.

```ts
import { readEnvLayers, setKey } from '@kindgi/dotenv-file';

const env = readEnvLayers([
  { source: '.env', contents: await readOrNull('.env') },
  { source: '.env.local', contents: await readOrNull('.env.local') },
]);
env.values.DATABASE_URL; // merged + expanded
env.origin.DATABASE_URL; // '.env.local' — which file supplied it

const { contents } = setKey(existingText, 'ANTHROPIC_API_KEY', key);
```

## Reading — `parseEnvFile`

Grammar is `dotenv`'s `parse()`, verified input-for-input against
`dotenv@16.3.1` (the version Next.js 16 bundles) in
`tests/conformance.test.ts` — a hand-picked corpus plus 3000 generated
inputs.

- `KEY=value` or `KEY: value`; optional leading whitespace and `export `.
- Keys `[A-Za-z0-9_.-]+`.
- Unquoted values stop at the first `#` and are trimmed.
- `'…'`, `"…"`, `` `…` `` may span lines. Inside double quotes `\n` and `\r`
  become newline / carriage return; nothing else is unescaped.
- Duplicate keys: last wins.
- Lines dotenv ignores come back as `malformed` so a rewrite never drops them.

Results are structured lines (`EnvLine`) — comments, blanks, malformed
lines and each entry's exact source text — so `serializeEnvFile(parseEnvFile(x))`
reproduces `x` (with `\n` line endings).

**One deliberate divergence:** dotenv's regex lets a key's separator, or an
empty value's leading whitespace, cross a newline (`KEY=` followed by a line
that starts with a quote joins the two). Here a key, its separator and the
start of its value are always on one line.

## Expanding — `expandEnv`

`$NAME`, `${NAME}`, `${NAME:-default}`, `${NAME-default}`, `${NAME:+alt}`,
`${NAME+alt}`, and `\$` for a literal `$`. Defaults nest.

Host frameworks don't agree on expansion — Next.js 16 bundles
`dotenv-expand` 10, Vite uses 12. Kindgi matches both wherever they agree
(verified in `tests/conformance.test.ts`) and chooses as follows where they
don't:

| Case | Next.js (expand 10) | Vite (expand 12) | Kindgi |
|---|---|---|---|
| `${A}`, A defined above | A | A | A |
| `A=$B`, B defined below | B | `""` | B |
| `${A:-d}`, A set in the same file | `d` | A | A |
| `${A-d}`, `${A:+x}`, `${A+x}` | not supported | supported | supported |
| `$1` | `""` | `$1` | `$1` |
| shell env vs. a file's own value | shell wins | shell wins | **file wins** |

The last row is intentional: the files are the source, and
`options.env` only fills names no file defines (so `${HOME}` works).
Nothing reads `process.env` unless the caller passes it. Undefined
references expand to `""`; cycles are cut; both are reported in
`diagnostics`.

## Layering — `readEnvLayers`

Several files as one view. Layers are ordered **lowest precedence first**;
a later layer's key wins. Raw values merge first and are expanded once over
the merged view, so a reference in `.env` to a name defined in `.env.local`
sees the `.env.local` value — the same result Next.js produces. Each key
reports its `origin`; malformed lines, unresolved references and cycles
come back as `diagnostics` with their source.

## Writing — `setKey`, `unsetKey`, `renderEntry`

`setKey` replaces the **last** occurrence of a key (the one readers see),
keeping its `export ` prefix, or appends. `unsetKey` removes every
occurrence. Every other line — comments, hand-written quoting, inline
comments, malformed lines — is kept byte-for-byte.

Values are rendered so they read back exactly, through dotenv and
expansion:

1. `[A-Za-z0-9_.,:/@+=%~-]+` → unquoted.
2. Otherwise double quotes, if the value has no `"` and no literal `\n` /
   `\r` sequence (real newlines are written as `\n`).
3. Otherwise single quotes, if no `'` and no carriage return.
4. Otherwise backticks, if no `` ` `` and no carriage return.
5. Otherwise `EnvValueNotRepresentableError` — never a silently different
   value.

`$` is always written as `\$`, because expanders substitute `$NAME` even
inside quotes and `\$` is the escape they all undo.

Writes accept only POSIX env names (`ENV_KEY_REGEX`, `[A-Z_][A-Z0-9_]*`),
so every key Kindgi writes can also be exported from a shell. Reads accept
everything dotenv does (`DOTENV_KEY_REGEX`).
