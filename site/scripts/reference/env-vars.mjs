// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The environment variables reference, from `@kindgi/env-schema`: every
 * `KINDGI_*` variable the runtime and the pack service read, grouped as
 * the schema groups them.
 *
 * A variable's `appliesTo` is a predicate over the deployment's choices
 * (which process reads it, the secrets backend, its KMS, the pack
 * transport). The page states those choices in words by evaluating the
 * predicate over every combination, so it can't drift from the schema.
 */
import { ENV_GROUPS, KINDGI_ENV_SCHEMA } from '@kindgi/env-schema';

const BACKENDS = ['none', 'postgres', 'dotenv', 'secret-manager'];
const KMS = ['gcp', 'azure', 'aws', 'libsodium', 'vault'];

/** Every server target: each backend × KMS × pack transport (and the unset forms). */
function serverTargets() {
  const targets = [];
  for (const secretsBackend of [undefined, ...BACKENDS]) {
    for (const secretsBackendKms of [undefined, ...KMS]) {
      for (const packTransport of [undefined, 'http']) {
        targets.push({ component: 'server', secretsBackend, secretsBackendKms, packTransport });
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
  const transport = [...values('packTransport')];
  if (transport.length === 1 && transport[0] === 'http') {
    words.push('when it calls a pack service (`KINDGI_PACK_SERVICE_URL` set)');
  }
  return words.join(', ');
}

function variable(spec) {
  const lines = [`### \`${spec.name}\``, '', spec.description, ''];
  lines.push(`- **Read by:** ${readBy(spec)}`);
  lines.push(`- **Required:** ${spec.required ? 'yes' : 'no'}`);
  if (spec.allowedValues?.length) {
    lines.push(`- **Values:** ${spec.allowedValues.map((v) => `\`${v}\``).join(', ')}`);
  }
  if (spec.example) lines.push(`- **Example:** \`${spec.example}\``);
  lines.push('');
  return lines.join('\n');
}

export function envVarsPage() {
  const byGroup = new Map();
  for (const spec of KINDGI_ENV_SCHEMA) {
    const group = spec.group ?? 'other';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(spec);
  }
  const out = [
    '---',
    'title: Environment variables',
    'description: Every KINDGI_* variable the Kindgi runtime and the pack service read.',
    '---',
    '',
    'Every `KINDGI_*` variable the Kindgi runtime (the server) and the pack',
    "service read. Generated from `@kindgi/env-schema`, Kindgi's own list, so",
    'it matches this version.',
    '',
    "The `KINDGI_` prefix is reserved for Kindgi: a pack can't declare such a",
    'name in its `env`, and `kindgi dev` never resolves one as a secret, so an',
    "app's own variables stay its own.",
    '',
  ];
  for (const [group, specs] of byGroup) {
    out.push(`## ${ENV_GROUPS[group] ?? 'Other'}`, '');
    for (const spec of specs) out.push(variable(spec));
  }
  return { slug: 'reference/env-vars', content: `${out.join('\n').trimEnd()}\n` };
}
