# Design tokens

Kindgi's colours, type and shapes, in one place for the website, the docs and
the console. Theme E, "steel and plum", in light and dark.

- [`tokens.json`](tokens.json) is the source: every colour with its light and
  dark value and what it's for, the fonts, corners and row heights, and the
  pairs whose contrast is checked.
- [`tokens.css`](tokens.css) is written from it by `pnpm run tokens:build`.
  Don't edit it by hand.
- `pnpm run check:tokens` (in CI) fails if `tokens.css` is out of date, or if
  any checked pair misses its contrast in either theme: 4.5:1 for text (WCAG
  AA), 3:1 for chart colours and component edges (WCAG 1.4.11).

## Using them

Import `tokens.css` and read the variables by role, never as raw colours:

```css
@import './tokens.css';

.card { background: var(--kg-card); border: 1px solid var(--kg-rule); color: var(--kg-text); }
```

Light is the default. Dark applies when the system asks for it, unless the page
chose light (`data-theme="light"` or a `light` class), and whenever the page
chooses dark (`data-theme="dark"`, as Starlight sets it, or a `dark` class, as
shadcn/ui sets it). Every name starts with `--kg-`, so it never meets a
surface's own variables: a surface maps its variables onto these.

The runtime keeps a pinned copy of `tokens.css` for the website and the
console, and its CI fails if the copy differs from this file at the pinned
commit.

## The rules

- **Two materials.** The page (`page`, `card`) is the reader's side;
  `kindgi` (graphite in light, plum-black in dark) marks what Kindgi runs.
  Only the website uses the Kindgi surface for whole sections.
- **Plum is rare.** `action` (plum in light, orchid in dark) is for a primary
  action, a person deciding, the logo, and rare labels such as "Preview".
  Nothing that repeats on every page wears it: not links, not menus, not
  rows. The website is the exception and may use it as a brand accent.
- **Menus stay neutral.** Navigation (headers, footers, the docs sidebar,
  the console's nav) uses `text` and `text-2`. The current item is `text`,
  bold, with a `line` edge and a faint tint of `text`.
- **Links** are their words and an arrow, no underline: `link`, then
  `link-hover` on hover.
- **Buttons** answer hover with a light shade change: filled buttons take
  `action-hover` (or `accent-hover`); outline buttons take a faint tint of
  `text` and a `text` edge.
- **Statuses** have six meanings: `person` (a person decides), `ok`, `bad`,
  `warn`, `info` and `muted`. Each status gets one colour touch: its icon and
  its word. Cards and alerts get a quiet full border, `*-line` mixed 45% with
  `rule`. The tints (`*-bg`) are for diff lines. A status always has an icon
  and a word, so colour is never the only signal.
- **Chart series** are five tones from indigo to teal, handed out interleaved
  (dark, light, dark-ish, light-ish, middle), so neighbours in a stack are
  two steps apart and every tone stays at least 3:1 against the card.
  `series-1`, the strongest tone, is for the biggest item; a chart takes
  `series-1`, `series-2`, … in order for any number of items. `series-muted`
  (warm stone) is for "everything else" and the previous period. They never
  use a status colour or plum. Stacked bars get a 2 px gap between segments,
  and the legend follows the stack order.
- **Code** sits on `code-bg`, neutral in both themes. Strings and the selected
  tab take the accent.
- **Type** is IBM Plex Sans for everything you read and IBM Plex Mono for code,
  self-hosted (SIL Open Font License). Headings and the wordmark are set at
  `narrow` (85% width).
- **Shape** is square (`radius`). Only form fields are slightly rounded
  (`radius-field`, 3px). Rows default to `row` (38px); a long list may offer
  `row-compact`.
