// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The environment variables reference, from `@kindgi/env-schema`: every
 * `KINDGI_*` variable the runtime, the pack service and the pack
 * orchestrator read, grouped as the schema groups them.
 *
 * A variable's `appliesTo` is a predicate over the deployment's choices
 * (which process reads it, the secrets backend, its KMS, the pack
 * transport). The page states those choices in words by evaluating the
 * predicate over every combination, so it can't drift from the schema.
 *
 * Each variable's entry has the reference layout: synopsis, description,
 * its values with the default, an example, see also. A default, and an
 * example the schema doesn't give, are written in `entries/env-vars.mjs`;
 * "see also" is the guides that name the variable, else its group's
 * hand-picked pages.
 */
import { ENV_GROUPS, KINDGI_ENV_SCHEMA } from '@kindgi/env-schema';

import { ENV_DEFAULTS, ENV_EXAMPLES, ENV_GROUP_SEE_ALSO } from './entries/env-vars.mjs';
import { distinctPages, linkTo } from './mentions.mjs';

export const SLUG = 'reference/env-vars';
export const TITLE = 'Environment variables';
/** At most this many guides in a variable's "see also". */
const GUIDE_LINKS = 4;

const BACKENDS = ['none', 'postgres', 'dotenv', 'secret-manager'];
const KMS = ['gcp', 'azure', 'aws', 'libsodium', 'vault'];
const MANAGERS = ['azure', 'gcp', 'aws', 'vault'];

/** Every server target: each backend × KMS × secret manager × pack transport (and the unset forms). */
function serverTargets() {
  const targets = [];
  for (const secretsBackend of [undefined, ...BACKENDS]) {
    for (const secretsBackendKms of [undefined, ...KMS]) {
      for (const secretsManager of [undefined, ...MANAGERS]) {
        for (const packTransport of [undefined, 'http']) {
          targets.push({
            component: 'server',
            secretsBackend,
            secretsBackendKms,
            secretsManager,
            packTransport,
          });
        }
      }
    }
  }
  return targets;
}

/** In words: which process reads the variable, and when. */
function readBy(spec) {
  const pack = spec.appliesTo({ component: 'pack-service' });
  const targets = serverTargets();
  const matching = targets.filter((t) => spec.appliesTo(t));
  const parts = [];
  if (matching.length === targets.length) {
    parts.push('the server');
  } else if (matching.length > 0) {
    parts.push(`the server, ${conditions(matching)}`);
  }
  if (pack) parts.push('the pack service');
  if (spec.appliesTo({ component: 'pack-orchestrator' })) {
    parts.push('the pack orchestrator (`kindgi-runtime packs orchestrate`)');
  }
  return parts.join('; ');
}

/** The narrowest description of the targets a variable applies to. */
function conditions(matching) {
  const values = (key) => new Set(matching.map((t) => t[key]));
  const words = [];
  const backends = [...values('secretsBackend')];
  if (backends.length < BACKENDS.length + 1) {
    words.push(`with \`KINDGI_SECRETS_BACKEND=${backends.filter(Boolean).join('` or `')}\``);
  }
  const kms = [...values('secretsBackendKms')];
  if (kms.length < KMS.length + 1) {
    words.push(`\`KINDGI_SECRETS_BACKEND_KMS=${kms.filter(Boolean).join('` or `')}\``);
  }
  const managers = [...values('secretsManager')];
  if (managers.length < MANAGERS.length + 1) {
    words.push(`\`KINDGI_SECRETS_MANAGER=${managers.filter(Boolean).join('` or `')}\``);
  }
  const transport = [...values('packTransport')];
  if (transport.length === 1 && transport[0] === 'http') {
    words.push('when it calls a pack service (`KINDGI_PACK_SERVICE_URL` set)');
  }
  return words.join(', ');
}

/** A variable's default, in words: `required`, or from `entries/env-vars.mjs`. */
export function envDefault(spec) {
  return spec.required ? 'none (required)' : ENV_DEFAULTS[spec.name];
}

/** A variable's example value: the schema's, else `entries/env-vars.mjs`'s. */
export function envExample(spec) {
  return spec.example || ENV_EXAMPLES[spec.name]?.value;
}

/**
 * A variable's example as lines to paste: a value the reader makes is made
 * in place (`NAME="$(openssl rand -base64 32)"`), under a comment saying
 * what it is.
 */
function exampleLines(spec) {
  const make = spec.example ? undefined : ENV_EXAMPLES[spec.name]?.make;
  if (!make) return [`${spec.name}=${envExample(spec) ?? ''}`];
  return [`# ${envExample(spec).replace(/^<|>$/g, '')}`, `${spec.name}="$(${make})"`];
}

/** The guides that name a variable, else its group's hand-picked pages. */
export function envSeeAlso(spec, mentions, pagesBySlug) {
  const named = distinctPages(mentions.codeSpans.get(spec.name), GUIDE_LINKS);
  const pages = named.length
    ? named
    : (ENV_GROUP_SEE_ALSO[spec.group ?? 'other'] ?? [])
        .map((slug) => pagesBySlug.get(slug))
        .filter(Boolean);
  return pages.map((page) => `[${page.title}](${linkTo(SLUG, page.slug)})`);
}

function variable(spec, mentions, pagesBySlug) {
  const value = spec.allowedValues?.length ? spec.allowedValues.join('|') : '<value>';
  const lines = [`### \`${spec.name}\``, ''];
  lines.push('**Synopsis**', '', '```sh signature', `${spec.name}=${value}`, '```', '');
  lines.push(spec.description, '');
  lines.push('**Values**', '');
  lines.push(`- **Read by:** ${readBy(spec)}`);
  lines.push(`- **Required:** ${spec.required ? 'yes' : 'no'}`);
  if (spec.allowedValues?.length) {
    lines.push(`- **Values:** ${spec.allowedValues.map((v) => `\`${v}\``).join(', ')}`);
  }
  lines.push(`- **Default:** ${envDefault(spec) ?? ''}`, '');
  lines.push('**Example**', '', '```sh', ...exampleLines(spec), '```', '');
  lines.push('**See also**', '');
  for (const link of envSeeAlso(spec, mentions, pagesBySlug)) lines.push(`- ${link}`);
  lines.push('');
  return lines.join('\n');
}

export function envVarsPage({ mentions, pages }) {
  const pagesBySlug = new Map(pages.map((page) => [page.slug, page]));
  const byGroup = new Map();
  for (const spec of KINDGI_ENV_SCHEMA) {
    const group = spec.group ?? 'other';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(spec);
  }
  const out = [
    '---',
    `title: ${TITLE}`,
    'description: Every KINDGI_* variable the Kindgi runtime, the pack service and the pack orchestrator read.',
    '---',
    '',
    'Every `KINDGI_*` variable the Kindgi runtime (the server), the pack',
    'service and the pack orchestrator read. Generated from',
    "`@kindgi/env-schema`, Kindgi's own list, so it matches this version.",
    '',
    "The `KINDGI_` prefix is reserved for Kindgi: a pack can't declare such a",
    'name in its `env`, and `kindgi dev` never resolves one as a secret, so an',
    "app's own variables stay its own.",
    '',
  ];
  for (const [group, specs] of byGroup) {
    out.push(`## ${ENV_GROUPS[group] ?? 'Other'}`, '');
    for (const spec of specs) out.push(variable(spec, mentions, pagesBySlug));
  }
  return { slug: SLUG, content: `${out.join('\n').trimEnd()}\n` };
}
