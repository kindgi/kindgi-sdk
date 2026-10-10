// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomInt } from 'node:crypto';

import type { WebhookSignature, WebhooksClient } from '@kindgi/client';
import type { EnvName } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { type Rendered, renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

type TriggerPage = Awaited<ReturnType<WebhooksClient['list']>>;
type Trigger = TriggerPage['data'][number];
type FirePage = Awaited<ReturnType<WebhooksClient['fires']>>;
type Fire = FirePage['data'][number];
type RegisterInput = Parameters<WebhooksClient['register']>[0];

/**
 * How each sender signs, from its own source (`--preset`): the API takes
 * the scheme itself, so a sender with no preset is `--signature-*` flags.
 */
export const WEBHOOK_PRESETS: Readonly<
  Record<
    string,
    {
      readonly signature: WebhookSignature;
      readonly deliveryIdHeader?: string;
      /** Where to paste the URL and the secret, in the sender. */
      readonly where: string;
    }
  >
> = {
  woocommerce: {
    signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
    deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
    where:
      'In WooCommerce: Settings → Advanced → Webhooks → Add webhook. One webhook per topic (`order.created`, …); Delivery URL: the receive URL; Secret: the secret. WooCommerce never resends a delivery Kindgi refuses, and switches the webhook off after 7 in a row.',
  },
  'drupal-webhooks': {
    signature: {
      kind: 'hmac-sha256',
      encoding: 'hex',
      header: 'X-Hub-Signature-256',
      prefix: 'sha256=',
    },
    deliveryIdHeader: 'X-Drupal-Delivery',
    where:
      "In Drupal's Webhooks module: add an outgoing webhook with the receive URL as its Payload URL and the secret as its Secret (it signs only with one).",
  },
  github: {
    signature: {
      kind: 'hmac-sha256',
      encoding: 'hex',
      header: 'X-Hub-Signature-256',
      prefix: 'sha256=',
    },
    deliveryIdHeader: 'X-GitHub-Delivery',
    where:
      "In GitHub: the repository's or organization's Settings → Webhooks → Add webhook; Payload URL: the receive URL; Content type: application/json; Secret: the secret.",
  },
  shopify: {
    signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-Shopify-Hmac-Sha256' },
    deliveryIdHeader: 'X-Shopify-Webhook-Id',
    where:
      "In Shopify: a webhook subscription to the receive URL; Shopify signs with the app's client secret, so store that as the secret.",
  },
  'standard-webhooks': {
    signature: { kind: 'standard-webhooks' },
    where:
      'In the sender: the receive URL as the endpoint, and the secret (`whsec_…`) as its signing secret.',
  },
};

const PRESET_NAMES = Object.keys(WEBHOOK_PRESETS).join('|');

const PAGE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
};

function page(ctx: CommandContext): { limit?: number; cursor?: string } {
  const limit = integerFlag(ctx, 'limit');
  const cursor = stringFlag(ctx, 'cursor');
  return {
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor }),
  };
}

/** How a trigger's sender signs, as one cell: `base64 X-WC-Webhook-Signature`, `standard-webhooks`. */
function signedCell(t: Trigger): string {
  const s = t.signature;
  if (s.kind === 'standard-webhooks') return 'standard-webhooks';
  return `${s.encoding} ${s.header}${s.prefix !== undefined ? ` (${s.prefix}…)` : ''}`;
}

const TRIGGERS_TABLE: TableSpec<TriggerPage, Trigger> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (t) => t.triggerId },
    { header: 'FLOW', get: (t) => `${t.flowId}@${t.flowVersion}` },
    { header: 'SIGNED', get: signedCell },
    { header: 'STATUS', get: (t) => t.status },
    { header: 'OWNER', get: (t) => t.owner.displayName ?? t.owner.id },
    { header: 'LAST', get: (t) => t.lastFiredAt ?? '' },
    { header: 'LABEL', get: (t) => t.label ?? '' },
  ],
};

const FIRES_TABLE: TableSpec<FirePage, Fire> = {
  rows: (p) => p.data,
  columns: [
    { header: 'RECEIVED', get: (f) => f.firedAt },
    { header: 'OUTCOME', get: (f) => f.outcome },
    { header: 'RUN', get: (f) => f.runId ?? '' },
    { header: 'NOTE', get: (f) => f.detail ?? '' },
    {
      header: 'REPEATS',
      get: (f) => (f.duplicates !== undefined ? String(f.duplicates) : ''),
    },
  ],
};

const SIGNATURE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  preset: {
    type: 'string',
    description: `How the sender signs, by sender: ${PRESET_NAMES}. Sets the scheme and the delivery-id header.`,
  },
  'signature-header': {
    type: 'string',
    description:
      'Instead of --preset: the header that carries an HMAC-SHA256 of the raw body (with --signature-encoding).',
  },
  'signature-encoding': {
    type: 'string',
    description: 'With --signature-header: `hex` or `base64`.',
  },
  'signature-prefix': {
    type: 'string',
    description: 'With --signature-header: stripped before decoding (e.g. `sha256=`).',
  },
  'delivery-id-header': {
    type: 'string',
    description:
      'The header whose value, with the body, dedupes deliveries (a preset sets it; `none` on update stops deduping).',
  },
  'body-limit': {
    type: 'string',
    description: 'The largest body it takes, in bytes (1024 to 1048576; default 262144).',
  },
  'rate-limit': {
    type: 'string',
    description: 'Accepted deliveries a minute (1 to 6000; default 600); past it, 429.',
  },
  label: { type: 'string', description: 'A short label.' },
};

/** The scheme and delivery fields from `--preset` or the `--signature-*` flags. */
function signatureFields(ctx: CommandContext): {
  signature?: WebhookSignature;
  deliveryIdHeader?: string | null;
} {
  const preset = stringFlag(ctx, 'preset');
  const header = stringFlag(ctx, 'signature-header');
  const encoding = stringFlag(ctx, 'signature-encoding');
  const prefix = stringFlag(ctx, 'signature-prefix');
  const delivery = stringFlag(ctx, 'delivery-id-header');
  const deliveryField =
    delivery === undefined ? {} : { deliveryIdHeader: delivery === 'none' ? null : delivery };
  if (preset !== undefined) {
    if (header !== undefined || encoding !== undefined || prefix !== undefined) {
      throw new Error('--preset sets the scheme: not with --signature-header/-encoding/-prefix');
    }
    const p = WEBHOOK_PRESETS[preset];
    if (p === undefined) throw new Error(`--preset must be one of ${PRESET_NAMES}`);
    return {
      signature: p.signature,
      ...(p.deliveryIdHeader !== undefined && { deliveryIdHeader: p.deliveryIdHeader }),
      ...deliveryField,
    };
  }
  if (header === undefined) {
    if (encoding !== undefined || prefix !== undefined) {
      throw new Error('--signature-encoding and --signature-prefix go with --signature-header');
    }
    return deliveryField;
  }
  if (encoding !== 'hex' && encoding !== 'base64') {
    throw new Error('--signature-header needs --signature-encoding=hex|base64');
  }
  return {
    signature: {
      kind: 'hmac-sha256',
      encoding,
      header,
      ...(prefix !== undefined && { prefix }),
    },
    ...deliveryField,
  };
}

function limitFields(ctx: CommandContext): {
  bodyLimitBytes?: number;
  rateLimitPerMinute?: number;
} {
  const body = integerFlag(ctx, 'body-limit');
  const rate = integerFlag(ctx, 'rate-limit');
  return {
    ...(body !== undefined && { bodyLimitBytes: body }),
    ...(rate !== undefined && { rateLimitPerMinute: rate }),
  };
}

/**
 * A new signing secret. `standard-webhooks`: `whsec_` and 32 random bytes in
 * base64. Otherwise 40 letters and digits: WooCommerce HTML-decodes its
 * secret before signing, so anything else could sign differently.
 */
export function generateSigningSecret(signature: WebhookSignature | undefined): string {
  if (signature?.kind === 'standard-webhooks') {
    return `whsec_${randomBytes(32).toString('base64')}`;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 40; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Where to point the sender, or why there's nothing to point it at yet. */
function receiveNote(t: Trigger): string {
  return t.receiveUrl !== undefined
    ? `  Receive URL (the sender posts here): ${t.receiveUrl}\n`
    : `  No receive URL: this deployment has no public URL configured. Set KINDGI_PUBLIC_URL on the runtime to the address your sender reaches it at, then \`kindgi webhooks get ${t.triggerId}\` shows it.\n`;
}

const register: LeafCommand = {
  kind: 'leaf',
  name: 'register',
  description:
    "Start a flow's run when a signed request arrives: from WooCommerce, Drupal's Webhooks module, GitHub, Shopify, or any sender that signs with HMAC-SHA256 or Standard Webhooks. Its runs act as you, checked again at every delivery. The event the flow gets is data from outside, never instructions: give the agent that reads it input guardrails.",
  usage: `kindgi webhooks register --flow=<id> --flow-version=<v> (--secret=<name> | --generate-secret --secret=<name> --env=<env>) [--preset=${PRESET_NAMES} | --signature-header=<h> --signature-encoding=hex|base64 [--signature-prefix=<p>]] [--delivery-id-header=<h>] [--input=<json-or-@file>] [--project=<project-id>] [--body-limit=<bytes>] [--rate-limit=<per-minute>] [--label=<text>]`,
  optionSpec: {
    flow: { type: 'string', description: 'The flow each delivery starts.' },
    'flow-version': { type: 'string', description: 'The flow version.' },
    secret: {
      type: 'string',
      description:
        "The signing secret's name (written with `kindgi secrets set`, at the tenant, in the env the runtime serves). Never a model provider's key.",
    },
    'generate-secret': {
      type: 'boolean',
      description:
        'Make a new signing secret, store it as --secret in --env (at the tenant), and show it once, to paste into the sender. Letters and digits only (WooCommerce HTML-decodes its secret); `whsec_…` with --preset=standard-webhooks.',
    },
    env: {
      type: 'string',
      description:
        'With --generate-secret: the env the runtime serves, where the secret is stored (`local` under `kindgi dev`).',
    },
    input: {
      type: 'string',
      description:
        "The flow's input on every delivery, in place of the event, as JSON or `@<file>` (default: the event).",
    },
    project: {
      type: 'string',
      description: "The trigger's project, by id (default: the tenant's Default project).",
    },
    ...SIGNATURE_FLAGS,
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'webhooks register', async (): Promise<Rendered> => {
      const flowId = stringFlag(ctx, 'flow');
      const flowVersion = stringFlag(ctx, 'flow-version');
      const secretName = stringFlag(ctx, 'secret');
      if (flowId === undefined || flowVersion === undefined) {
        throw new Error('--flow=<id> and --flow-version=<v> are required');
      }
      if (secretName === undefined) throw new Error('--secret=<name> is required');
      const signing = signatureFields(ctx);
      const generate = ctx.options['generate-secret'] === true;
      let generated: { value: string; env: string } | undefined;
      if (generate) {
        const env = stringFlag(ctx, 'env');
        if (env === undefined) {
          throw new Error(
            '--generate-secret needs --env=<env>: the env the runtime serves (`local` under `kindgi dev`)',
          );
        }
        const value = generateSigningSecret(signing.signature);
        const stored = await ctx.client().secrets.set({
          scope: { kind: 'tenant' },
          envName: env as EnvName,
          name: secretName,
          value,
          writeMode: 'create-new',
        });
        if (stored.kind !== 'ok') {
          throw new Error(
            `A secret named ${secretName} already exists in ${env}: pick another --secret, or store your own value with \`kindgi secrets set\` and drop --generate-secret`,
          );
        }
        generated = { value, env };
      }
      const input = stringFlag(ctx, 'input');
      const project = stringFlag(ctx, 'project');
      const label = stringFlag(ctx, 'label');
      const deliveryIdHeader = signing.deliveryIdHeader;
      const trigger = await ctx.client().webhooks.register({
        flowId,
        flowVersion,
        hmacSecretName: secretName,
        ...(signing.signature !== undefined && { signature: signing.signature }),
        ...(typeof deliveryIdHeader === 'string' && { deliveryIdHeader }),
        ...limitFields(ctx),
        ...(input !== undefined && { config: { input: await readJsonInput(input) } }),
        ...(project !== undefined && { projectId: project }),
        ...(label !== undefined && { label }),
      } as RegisterInput);
      const preset = stringFlag(ctx, 'preset');
      const rendered = renderJson(trigger, ctx.globals.format);
      return {
        stdout: rendered.stdout,
        stderr: [
          '',
          `  Registered webhook trigger ${trigger.triggerId}: each signed delivery starts ${flowId}@${flowVersion}.`,
          receiveNote(trigger).trimEnd(),
          ...(generated !== undefined
            ? [
                `  Signing secret (stored as ${secretName} in ${generated.env}; shown this once): ${generated.value}`,
              ]
            : []),
          ...(preset !== undefined ? [`  ${WEBHOOK_PRESETS[preset]?.where ?? ''}`] : []),
          '',
          '',
        ].join('\n'),
      };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List webhook triggers.',
  usage:
    'kindgi webhooks list [--project=<project-id>] [--status=active|paused] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    project: { type: 'string', description: "Only this project's webhook triggers." },
    status: { type: 'string', description: 'Only `active` or only `paused` triggers.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'webhooks list',
      async () => {
        const status = stringFlag(ctx, 'status');
        if (status !== undefined && status !== 'active' && status !== 'paused') {
          throw new Error('--status must be `active` or `paused`');
        }
        const projectId = stringFlag(ctx, 'project');
        return await ctx.client().webhooks.list({
          ...page(ctx),
          ...(status !== undefined && { status }),
          ...(projectId !== undefined && { projectId }),
        });
      },
      TRIGGERS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a webhook trigger, with its receive URL.',
  usage: 'kindgi webhooks get <trigger-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'webhooks get', async () => {
      const trigger = await ctx.client().webhooks.get(requiredPositional(ctx, 0, 'trigger-id'));
      const rendered = renderJson(trigger, ctx.globals.format);
      return { stdout: rendered.stdout, stderr: `\n${receiveNote(trigger)}\n` };
    }),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    'Change a webhook trigger: its flow version, input, secret, scheme, delivery-id header or limits. Its flow stays: register another trigger for another flow.',
  usage: `kindgi webhooks update <trigger-id> [--flow-version=<v>] [--input=<json-or-@file>] [--secret=<name>] [--preset=${PRESET_NAMES} | --signature-header=<h> --signature-encoding=hex|base64 [--signature-prefix=<p>]] [--delivery-id-header=<h>|none] [--body-limit=<bytes>] [--rate-limit=<per-minute>] [--label=<text>]`,
  optionSpec: {
    'flow-version': { type: 'string', description: 'Start this flow version instead.' },
    input: {
      type: 'string',
      description: "The flow's input on every delivery, as JSON or `@<file>`.",
    },
    secret: {
      type: 'string',
      description:
        "Verify with another secret, by name. To change a secret's value, use `kindgi secrets rotate`.",
    },
    ...SIGNATURE_FLAGS,
  },
  run: (ctx) =>
    runSdk(ctx, 'webhooks update', async () => {
      const id = requiredPositional(ctx, 0, 'trigger-id');
      const flowVersion = stringFlag(ctx, 'flow-version');
      const input = stringFlag(ctx, 'input');
      const secret = stringFlag(ctx, 'secret');
      const label = stringFlag(ctx, 'label');
      return await ctx.client().webhooks.update(id, {
        ...(flowVersion !== undefined && { flowVersion }),
        ...(input !== undefined && { config: { input: await readJsonInput(input) } }),
        ...(secret !== undefined && { hmacSecretName: secret }),
        ...signatureFields(ctx),
        ...limitFields(ctx),
        ...(label !== undefined && { label }),
      });
    }),
};

const pause: LeafCommand = {
  kind: 'leaf',
  name: 'pause',
  description:
    'Pause a webhook trigger. Deliveries are still taken (so the sender keeps the webhook on), recorded as skipped, and start nothing: their events are dropped, and WooCommerce never resends them.',
  usage: 'kindgi webhooks pause <trigger-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'webhooks pause', async () => {
      const trigger = await ctx.client().webhooks.pause(requiredPositional(ctx, 0, 'trigger-id'));
      const rendered = renderJson(trigger, ctx.globals.format);
      return {
        stdout: rendered.stdout,
        stderr:
          '\n  Paused. Deliveries are taken and recorded as skipped (`kindgi webhooks fires`), and start nothing: their events are dropped. WooCommerce never resends them, so resuming does not bring them back.\n\n',
      };
    }),
};

function byId(
  name: string,
  description: string,
  call: (client: WebhooksClient, id: string) => Promise<unknown>,
): LeafCommand {
  return {
    kind: 'leaf',
    name,
    description,
    usage: `kindgi webhooks ${name} <trigger-id>`,
    run: (ctx) =>
      runSdk(ctx, `webhooks ${name}`, async () =>
        call(ctx.client().webhooks, requiredPositional(ctx, 0, 'trigger-id')),
      ),
  };
}

const fires: LeafCommand = {
  kind: 'leaf',
  name: 'fires',
  description:
    "A webhook trigger's deliveries, newest first: the run each started, or why it was skipped (paused) or refused (a wrong or missing signature, a stale one, the limits, …). A fire keeps the event only until its run starts.",
  usage: 'kindgi webhooks fires <trigger-id> [--limit=<n>] [--cursor=<c>]',
  optionSpec: PAGE_FLAGS,
  run: (ctx) =>
    runSdk(
      ctx,
      'webhooks fires',
      async () =>
        await ctx.client().webhooks.fires(requiredPositional(ctx, 0, 'trigger-id'), page(ctx)),
      FIRES_TABLE,
    ),
};

export const webhooksCommand: Command = {
  kind: 'group',
  name: 'webhooks',
  description:
    'Start flow runs from signed webhooks (WooCommerce, Drupal, GitHub, Shopify, Standard Webhooks): register, list, get, update, pause, resume, fires, take-ownership, unregister.',
  subcommands: [
    register,
    list,
    get,
    update,
    pause,
    byId('resume', 'Resume a paused webhook trigger: deliveries start runs again.', (w, id) =>
      w.resume(id),
    ),
    fires,
    byId(
      'take-ownership',
      "Become a webhook trigger's owner, so its runs act as you (for a trigger whose owner left).",
      (w, id) => w.takeOwnership(id),
    ),
    byId(
      'unregister',
      'Remove a webhook trigger: its sender is answered 410 from now on.',
      (w, id) => w.unregister(id),
    ),
  ],
};
