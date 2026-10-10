// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether `kindgi dev` runs the pack service sandboxed, and what the
 * sandbox lets through: `KINDGI_DEV_SANDBOX` and `dev.sandbox` in the
 * pack's config.
 *
 * - `on` (the default): sandboxed where this machine can; where it
 *   can't, `kindgi dev` warns and runs it without.
 * - `off`: never (`KINDGI_DEV_SANDBOX=off`, or `dev.sandbox: false`).
 * - `required`: sandboxed, or the pack service doesn't start.
 *
 * `dev.sandbox.allowRead` and `dev.sandbox.allowUnixSockets` open a path
 * or a socket outside the app, such as `~/.aws` for a tool on the AWS
 * SDK's credential chain. `kindgi dev` names them at every start.
 */

import { isAbsolute, join, resolve } from 'node:path';

import type { PackConfigRecord } from '../../pack-config.js';

/** The variable that sets {@link DevSandboxMode}. */
export const DEV_SANDBOX_VAR = 'KINDGI_DEV_SANDBOX';

export type DevSandboxMode = 'on' | 'off' | 'required';

export interface DevSandboxSettings {
  readonly mode: DevSandboxMode;
  /** What set the mode: nothing, `KINDGI_DEV_SANDBOX`, or `dev.sandbox`. */
  readonly source: 'default' | 'env' | 'config';
  /** Absolute paths the pack service may also read (`dev.sandbox.allowRead`). */
  readonly allowRead: readonly string[];
  /** Absolute paths of UNIX sockets it may also connect to (`dev.sandbox.allowUnixSockets`). */
  readonly allowUnixSockets: readonly string[];
}

export type DevSandboxSettingsOutcome =
  | { readonly kind: 'ok'; readonly value: DevSandboxSettings }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * The settings from the environment and the config. `KINDGI_DEV_SANDBOX`
 * wins over `dev.sandbox` for the mode; the allow lists come from the
 * config. A path is absolute, `~/…`, or relative to the pack root.
 */
export function devSandboxSettings(
  config: PackConfigRecord | undefined,
  env: Readonly<Record<string, string | undefined>>,
  paths: { readonly packDir: string; readonly home: string },
): DevSandboxSettingsOutcome {
  const raw = env[DEV_SANDBOX_VAR];
  if (raw !== undefined && raw !== '' && raw !== 'on' && raw !== 'off' && raw !== 'required') {
    return {
      kind: 'invalid',
      message: `${DEV_SANDBOX_VAR} must be \`on\`, \`off\` or \`required\`, not ${JSON.stringify(raw)}`,
    };
  }
  const dev = config?.dev;
  const sandbox =
    dev !== null && typeof dev === 'object' && !Array.isArray(dev)
      ? (dev as Record<string, unknown>).sandbox
      : undefined;
  const fromConfig = configSandbox(sandbox, paths);
  if (fromConfig.kind === 'invalid') return fromConfig;
  const { enabled, allowRead, allowUnixSockets } = fromConfig.value;
  if (raw !== undefined && raw !== '') {
    return { kind: 'ok', value: { mode: raw, source: 'env', allowRead, allowUnixSockets } };
  }
  return {
    kind: 'ok',
    value: {
      mode: enabled ? 'on' : 'off',
      source: enabled ? 'default' : 'config',
      allowRead,
      allowUnixSockets,
    },
  };
}

function configSandbox(
  sandbox: unknown,
  paths: { readonly packDir: string; readonly home: string },
):
  | {
      readonly kind: 'ok';
      readonly value: {
        readonly enabled: boolean;
        readonly allowRead: readonly string[];
        readonly allowUnixSockets: readonly string[];
      };
    }
  | { readonly kind: 'invalid'; readonly message: string } {
  if (sandbox === undefined || sandbox === true) {
    return { kind: 'ok', value: { enabled: true, allowRead: [], allowUnixSockets: [] } };
  }
  if (sandbox === false) {
    return { kind: 'ok', value: { enabled: false, allowRead: [], allowUnixSockets: [] } };
  }
  const shape =
    '`dev.sandbox` must be `false`, or an object with `allowRead` and `allowUnixSockets` (lists of paths)';
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    return { kind: 'invalid', message: shape };
  }
  const record = sandbox as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (k) => k !== 'allowRead' && k !== 'allowUnixSockets',
  );
  if (unknownKeys.length > 0) {
    return {
      kind: 'invalid',
      message: `${shape}; not ${unknownKeys.map((k) => `\`${k}\``).join(', ')}`,
    };
  }
  const lists: Record<'allowRead' | 'allowUnixSockets', string[]> = {
    allowRead: [],
    allowUnixSockets: [],
  };
  for (const key of ['allowRead', 'allowUnixSockets'] as const) {
    const list = record[key];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      !list.every((p): p is string => typeof p === 'string' && p.trim() !== '')
    ) {
      return { kind: 'invalid', message: `\`dev.sandbox.${key}\` must be a list of paths` };
    }
    lists[key] = list.map((p) => expandPath(p.trim(), paths));
  }
  return { kind: 'ok', value: { enabled: true, ...lists } };
}

/** `~/x` under home, a relative path under the pack root, an absolute one as is. */
function expandPath(
  path: string,
  paths: { readonly packDir: string; readonly home: string },
): string {
  if (path === '~') return paths.home;
  if (path.startsWith('~/')) return join(paths.home, path.slice(2));
  return isAbsolute(path) ? path : resolve(paths.packDir, path);
}
