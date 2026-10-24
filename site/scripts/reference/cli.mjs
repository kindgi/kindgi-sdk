// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The CLI reference, from `@kindgi/cli`'s `describeCommands()`: one page
 * per top-level command (its subcommands as sections), and an overview
 * with the global flags.
 *
 * Every command's entry has the reference layout: synopsis, description,
 * options with their defaults, examples, see also. The command, its usage
 * and its flags come from the CLI's own definitions. The defaults, and the
 * examples the guides don't already show, are written in
 * `entries/cli.mjs`. The guides' own command lines are examples too, and
 * the guides that run a command are its "see also".
 */
import { describeCommands, describeGlobalFlags } from '@kindgi/cli';

import {
  CLI_DEFAULTS,
  CLI_EXAMPLES,
  CLI_GROUP_SEE_ALSO,
  GLOBAL_FLAG_DEFAULTS,
} from './entries/cli.mjs';
import { distinctPages, headingId, linkTo } from './mentions.mjs';

/** At most this many guide lines as examples, and this many guides in "see also". */
const GUIDE_EXAMPLES = 2;
const GUIDE_LINKS = 4;

/** Markdown-safe inline text: `<`/`>` escaped outside code spans, where an
 * entity would show literally. */
function text(value) {
  return value
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('');
}

/** A table cell: `|` escaped (inside code spans too, as GFM needs). */
function cell(value) {
  return text(value).replace(/\|/g, '\\|');
}

/** Every command, depth first. */
export function allCommands(commands = describeCommands()) {
  const out = [];
  const walk = (command) => {
    out.push(command);
    for (const sub of command.subcommands) walk(sub);
  };
  for (const command of commands) walk(command);
  return out;
}

/**
 * A flag's default, in words: from `entries/cli.mjs` (a global flag's when
 * `commandPath` is undefined), else `off` for a boolean.
 */
export function flagDefault(commandPath, flag) {
  const stated =
    commandPath === undefined
      ? GLOBAL_FLAG_DEFAULTS[flag.name]
      : CLI_DEFAULTS[commandPath]?.[flag.name];
  if (stated !== undefined) return stated;
  return flag.type === 'boolean' ? 'off' : undefined;
}

function optionsTable(commandPath, flags) {
  const rows = flags.map((flag) => {
    const name = `\`--${flag.name}${flag.type === 'string' ? ' <value>' : ''}\``;
    const short = flag.short ? `, \`-${flag.short}\`` : '';
    const repeat = flag.multiple ? ' Repeatable.' : '';
    const description = `${cell(flag.description ?? '')}${repeat}`;
    return `| ${name}${short} | ${cell(flagDefault(commandPath, flag) ?? '')} | ${description} |`;
  });
  return ['| Option | Default | Description |', '| --- | --- | --- |', ...rows];
}

/** The guides a command's "see also" links: the ones that run it, else its group's. */
function guidePages(command, mentions) {
  const path = command.path.join(' ');
  const own = (mentions.commands.get(path) ?? []).map((m) => m.page);
  if (own.length > 0) return distinctPages(own, GUIDE_LINKS);
  const top = command.path[0];
  const group = [...mentions.commands.entries()]
    .filter(([p]) => p === top || p.startsWith(`${top} `))
    .flatMap(([, uses]) => uses.map((m) => m.page));
  return distinctPages(group, GUIDE_LINKS);
}

/**
 * "See also" for a command: the guides that use it or its group, else the
 * group's hand-picked pages; then its parent command.
 */
export function seeAlso(command, mentions, pagesBySlug, fromSlug) {
  const links = [];
  for (const page of guidePages(command, mentions)) {
    links.push(`[${page.title}](${linkTo(fromSlug, page.slug)})`);
  }
  if (links.length === 0) {
    for (const slug of CLI_GROUP_SEE_ALSO[command.path[0]] ?? []) {
      const page = pagesBySlug.get(slug);
      if (page) links.push(`[${page.title}](${linkTo(fromSlug, slug)})`);
    }
  }
  if (command.path.length > 1) {
    const parent = `kindgi ${command.path.slice(0, -1).join(' ')}`;
    links.push(`[\`${parent}\`](#${headingId(parent)})`);
  }
  return links;
}

/** A runnable command's examples: the written ones, then the guides' own lines. */
export function examples(command, mentions) {
  const path = command.path.join(' ');
  const written = CLI_EXAMPLES[path] ?? [];
  const seen = new Set(written.map((example) => example.line));
  const fromGuides = [];
  for (const { page, line } of mentions.commands.get(path) ?? []) {
    if (fromGuides.length >= GUIDE_EXAMPLES || seen.has(line)) continue;
    seen.add(line);
    fromGuides.push({ page, line });
  }
  return { written, fromGuides };
}

function entry(command, depth, context) {
  const { mentions, pagesBySlug, slug } = context;
  const path = command.path.join(' ');
  const group = command.subcommands.length > 0;
  const lines = [`${'#'.repeat(Math.min(depth, 4))} \`kindgi ${path}\``, ''];
  const synopsis = group ? `kindgi ${path} <command>` : command.usage;
  // A synopsis is a signature, not a command to paste, and is marked so.
  lines.push('**Synopsis**', '', '```sh signature', synopsis, '```', '');
  lines.push(text(command.description), '');
  if (group) {
    lines.push('**Commands**', '', '| Command | Description |', '| --- | --- |');
    for (const sub of command.subcommands) {
      const name = `kindgi ${sub.path.join(' ')}`;
      const summary = sub.description.split('. ')[0].replace(/\.$/, '');
      lines.push(`| [\`${name}\`](#${headingId(name)}) | ${cell(summary)}. |`);
    }
    lines.push('');
  } else {
    lines.push('**Options**', '');
    if (command.flags.length > 0) lines.push(...optionsTable(path, command.flags), '');
    const globals = linkTo(slug, 'reference/cli/index', 'global-flags');
    lines.push(`Every command also takes the [global flags](${globals}).`, '');
    const { written, fromGuides } = examples(command, mentions);
    lines.push('**Examples**', '');
    for (const example of written) {
      lines.push(text(example.purpose), '', '```sh', example.line, '```', '');
    }
    const byPage = new Map();
    for (const { page, line } of fromGuides) {
      if (!byPage.has(page.slug)) byPage.set(page.slug, { page, lines: [] });
      byPage.get(page.slug).lines.push(line);
    }
    for (const { page, lines: used } of byPage.values()) {
      lines.push(
        `From [${page.title}](${linkTo(slug, page.slug)}):`,
        '',
        '```sh',
        ...used,
        '```',
        '',
      );
    }
  }
  lines.push('**See also**', '');
  for (const link of seeAlso(command, mentions, pagesBySlug, slug)) lines.push(`- ${link}`);
  lines.push('');
  for (const sub of command.subcommands) lines.push(entry(sub, depth + 1, context));
  return lines.join('\n');
}

function commandPage(command, order, mentions, pagesBySlug) {
  const slug = `reference/cli/${command.name}`;
  const lines = [
    '---',
    `title: kindgi ${command.name}`,
    `description: ${JSON.stringify(command.description.split('. ')[0].replace(/\.$/, ''))}`,
    'sidebar:',
    `  order: ${order}`,
    '---',
    '',
    entry(command, 2, { mentions, pagesBySlug, slug }),
  ];
  return { slug, content: `${lines.join('\n').trimEnd()}\n` };
}

export function cliPages({ mentions, pages }) {
  const commands = describeCommands();
  const pagesBySlug = new Map(pages.map((page) => [page.slug, page]));
  const overview = [
    '---',
    'title: CLI',
    'description: Every kindgi command, its flags and its subcommands.',
    'sidebar:',
    '  order: 0',
    '  label: Overview',
    '---',
    '',
    'The `kindgi` command-line interface (`@kindgi/cli`). Generated from the',
    "CLI's own command definitions, so it matches this version. Each command",
    'has its synopsis, what it does, its options with their defaults,',
    'examples, and the guides that use it.',
    '',
    '## Commands',
    '',
    ...commands.map((c) => `- [\`kindgi ${c.name}\`](${c.name}/): ${text(c.description)}`),
    '',
    '## Global flags',
    '',
    'Every command takes these:',
    '',
    ...optionsTable(undefined, describeGlobalFlags()),
    '',
    "In a folder where `kindgi dev` ran, its `.kindgirc.json` points every command at the dev runtime, ahead of `kindgi auth login`; `--hosted` goes to the CLI's own address in its place. A command that goes to the dev runtime while another address is in reach says so first, on stderr:",
    '',
    '```text',
    'kindgi auth whoami goes to the kindgi dev runtime at http://127.0.0.1:4000 (…/.kindgirc.json says so). For https://platform.kindgi.com, pass --hosted.',
    '```',
    '',
    "When the key was given with `--token` or `KINDGI_API_TOKEN` and nothing else is signed in, the line ends `To send it to the address your key is for, pass --url <that address> or export KINDGI_API_URL.` in place of the `--hosted` sentence. There's no line when `--url` or `KINDGI_API_URL` named the address, or when the dev runtime is the only one in reach.",
    '',
    '## Exit codes',
    '',
    '- `0`: the command succeeded.',
    '- `1`: the API refused the call, or what the command ran failed: a failed run',
    '  (`kindgi runs start`), a failing check (`kindgi doctor`).',
    '- `2`: a usage error: an unknown command, subcommand or flag, a missing argument',
    "  or flag, or a value a flag can't take. The error says which.",
    '- `130`: you stopped it with Ctrl+C while it waited (`kindgi runs start`, a',
    '  starting `kindgi dev`).',
    '',
  ];
  return [
    { slug: 'reference/cli/index', content: overview.join('\n') },
    ...commands.map((command, i) => commandPage(command, i + 1, mentions, pagesBySlug)),
  ];
}
