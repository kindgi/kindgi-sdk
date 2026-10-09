// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The CLI reference, from `@kindgi/cli`'s `describeCommands()`: one page
 * per top-level command (its subcommands as sections), and an overview
 * with the global flags.
 */
import { describeCommands, describeGlobalFlags } from '@kindgi/cli';

/** Markdown-safe inline text: `<`/`>` escaped outside code spans, where an
 * entity would show literally. */
function text(value) {
  return value
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('');
}

function flagLine(flag) {
  const name = `\`--${flag.name}${flag.type === 'string' ? ' <value>' : ''}\``;
  const short = flag.short ? ` (\`-${flag.short}\`)` : '';
  const notes = [];
  if (flag.multiple) notes.push('repeatable');
  if (flag.default !== undefined) notes.push(`default \`${flag.default}\``);
  const description = flag.description ? `: ${text(flag.description)}` : '';
  const extra = notes.length ? ` (${notes.join(', ')})` : '';
  return `- ${name}${short}${description}${extra}`;
}

function section(command, depth) {
  const heading = '#'.repeat(Math.min(depth, 4));
  const lines = [
    `${heading} \`kindgi ${command.path.join(' ')}\``,
    '',
    text(command.description),
    '',
  ];
  if (command.usage) lines.push('```sh', command.usage, '```', '');
  if (command.flags.length > 0) {
    lines.push('Flags:', '', ...command.flags.map(flagLine), '');
  }
  for (const sub of command.subcommands) lines.push(section(sub, depth + 1));
  return lines.join('\n');
}

function commandPage(command, order) {
  const lines = [
    '---',
    `title: kindgi ${command.name}`,
    `description: ${JSON.stringify(command.description.split('. ')[0].replace(/\.$/, ''))}`,
    'sidebar:',
    `  order: ${order}`,
    '---',
    '',
    text(command.description),
    '',
  ];
  if (command.usage) lines.push('```sh', command.usage, '```', '');
  if (command.flags.length > 0) lines.push('Flags:', '', ...command.flags.map(flagLine), '');
  for (const sub of command.subcommands) lines.push(section(sub, 2));
  lines.push('Every command also takes the [global flags](../#global-flags).', '');
  return lines.join('\n');
}

export function cliPages() {
  const commands = describeCommands();
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
    "CLI's own command definitions, so it matches this version.",
    '',
    '## Commands',
    '',
    ...commands.map((c) => `- [\`kindgi ${c.name}\`](${c.name}/): ${text(c.description)}`),
    '',
    '## Global flags',
    '',
    'Every command takes these:',
    '',
    ...describeGlobalFlags().map(flagLine),
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
    ...commands.map((command, i) => ({
      slug: `reference/cli/${command.name}`,
      content: commandPage(command, i + 1),
    })),
  ];
}
