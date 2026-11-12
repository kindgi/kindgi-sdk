// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `image` in a TypeScript pack's `kindgi.config.*` (`@kindgi/sdk/build`),
 * checked and resolved into what the Containerfile renders:
 *   - the Debian packages, the config's and the extensions', deduplicated;
 *   - the build env, the extensions' merged under the config's own;
 *   - the files the steps read, relative to the pack folder;
 *   - the steps, in extension order.
 * A config that isn't the documented shape fails the build, naming the
 * field — never a silently different image.
 */

import type { BuildExtension, BuildStep } from '@kindgi/handler-runtime/build-extensions';

import { checkAptPackages } from './apt.js';
import { forbiddenReason } from './context-files.js';

export interface ResolvedImage {
  readonly systemPackages: readonly string[];
  readonly buildEnv: Readonly<Record<string, string>>;
  /** Relative to the pack folder, sorted. */
  readonly contextFiles: readonly string[];
  readonly steps: readonly (BuildStep & { readonly extension: string })[];
  /** The extensions' names, in order. */
  readonly extensions: readonly string[];
  /** Which installed dependencies the image carries (`'all'` unless the config says `'loaded'`). */
  readonly dependencies: 'loaded' | 'all';
  /** `image.keep`: kept with `'loaded'`; one that isn't installed fails the build. Sorted. */
  readonly keep: readonly string[];
  /** The extensions' keeps: kept with `'loaded'` when installed. Sorted. */
  readonly keepIfInstalled: readonly string[];
}

export type ImageConfigOutcome =
  | { readonly kind: 'ok'; readonly image: ResolvedImage }
  | { readonly kind: 'invalid'; readonly message: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BIN = /^[A-Za-z0-9@._/-]+$/;
/** A name Node resolves under `node_modules`: `name`, `@scope/name`, or a folder such as `.prisma/client`. */
const KEEP_NAME = /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)?$/;

/** `image` from the loaded config (absent: nothing beyond the install). */
export function readImageConfig(config: Readonly<Record<string, unknown>>): ImageConfigOutcome {
  const image = config.image;
  if (image === undefined) {
    return {
      kind: 'ok',
      image: {
        systemPackages: [],
        buildEnv: {},
        contextFiles: [],
        steps: [],
        extensions: [],
        dependencies: 'all',
        keep: [],
        keepIfInstalled: [],
      },
    };
  }
  if (image === null || typeof image !== 'object' || Array.isArray(image)) {
    return invalid(
      '`image` in kindgi.config must be an object: { systemPackages?, extensions?, buildEnv?, dependencies?, keep? }.',
    );
  }
  const { systemPackages, extensions, buildEnv, dependencies, keep, ...rest } = image as Record<
    string,
    unknown
  >;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    return invalid(
      `\`image\` in kindgi.config has ${unknown.map((k) => `\`${k}\``).join(', ')}: it takes systemPackages, extensions, buildEnv, dependencies and keep.`,
    );
  }
  if (dependencies !== undefined && dependencies !== 'loaded' && dependencies !== 'all') {
    return invalid(
      `\`image.dependencies\` is 'loaded' (only what the pack's code loads) or 'all' (every production dependency). Got ${JSON.stringify(dependencies)}.`,
    );
  }
  const ownKeep = checkKeep(keep, 'image.keep');
  if (ownKeep.kind === 'invalid') return ownKeep;
  if (extensions !== undefined && !Array.isArray(extensions)) {
    return invalid('`image.extensions` must be a list of build extensions (`@kindgi/sdk/build`).');
  }

  const packages: unknown[] = [];
  if (systemPackages !== undefined) {
    if (!Array.isArray(systemPackages))
      return invalid('`image.systemPackages` must be a list of Debian package names.');
    packages.push(...systemPackages);
  }
  const env: Record<string, string> = {};
  const files = new Set<string>();
  const steps: (BuildStep & { extension: string })[] = [];
  const names: string[] = [];
  const extensionKeep = new Set<string>();

  for (const [i, raw] of (extensions ?? []).entries()) {
    const checked = checkExtension(raw, `image.extensions[${i}]`);
    if (checked.kind === 'invalid') return checked;
    const extension = checked.extension;
    names.push(extension.name);
    packages.push(...(extension.systemPackages ?? []));
    for (const file of extension.contextFiles ?? []) files.add(file);
    for (const step of extension.postInstall ?? [])
      steps.push({ ...step, extension: extension.name });
    for (const name of extension.keep ?? []) extensionKeep.add(name);
    Object.assign(env, extension.buildEnv ?? {});
  }
  const ownEnv = checkEnv(buildEnv, 'image.buildEnv');
  if (ownEnv.kind === 'invalid') return ownEnv;
  Object.assign(env, ownEnv.env);

  const apt = checkAptPackages(packages, 'image.systemPackages');
  if (apt.kind === 'err') return invalid(`${apt.message}.`);
  return {
    kind: 'ok',
    image: {
      systemPackages: apt.packages,
      buildEnv: env,
      contextFiles: [...files].sort(),
      steps,
      extensions: names,
      dependencies: dependencies ?? 'all',
      keep: ownKeep.keep,
      keepIfInstalled: [...extensionKeep].filter((n) => !ownKeep.keep.includes(n)).sort(),
    },
  };
}

function checkExtension(
  raw: unknown,
  where: string,
):
  | { readonly kind: 'ok'; readonly extension: BuildExtension }
  | { readonly kind: 'invalid'; readonly message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid(`${where} must be a build extension (\`@kindgi/sdk/build\`).`);
  }
  const ext = raw as Record<string, unknown>;
  if (typeof ext.name !== 'string' || ext.name === '') return invalid(`${where} has no \`name\`.`);
  const label = `${where} (${ext.name})`;
  const files = ext.contextFiles;
  if (files !== undefined) {
    if (!Array.isArray(files) || !files.every((f) => typeof f === 'string' && f !== '')) {
      return invalid(
        `${label}: \`contextFiles\` must be a list of paths relative to the pack folder.`,
      );
    }
    for (const file of files as string[]) {
      if (file.startsWith('/') || file.split('/').includes('..')) {
        return invalid(`${label}: ${file} isn't inside the pack folder.`);
      }
      const reason = forbiddenReason(file);
      if (reason !== undefined)
        return invalid(`${label}: refusing to put ${file} in the image (${reason}).`);
    }
  }
  const steps = ext.postInstall;
  if (steps !== undefined) {
    if (!Array.isArray(steps))
      return invalid(`${label}: \`postInstall\` must be a list of { bin, args }.`);
    for (const step of steps) {
      const s = step as { bin?: unknown; args?: unknown } | null;
      if (s === null || typeof s.bin !== 'string' || !BIN.test(s.bin)) {
        return invalid(
          `${label}: each \`postInstall\` step needs a \`bin\`, a package's executable name.`,
        );
      }
      if (
        s.args !== undefined &&
        (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string'))
      ) {
        return invalid(`${label}: \`postInstall\` args must be strings.`);
      }
    }
  }
  if (ext.systemPackages !== undefined && !Array.isArray(ext.systemPackages)) {
    return invalid(`${label}: \`systemPackages\` must be a list of Debian package names.`);
  }
  const env = checkEnv(ext.buildEnv, `${label} buildEnv`);
  if (env.kind === 'invalid') return env;
  const keep = checkKeep(ext.keep, `${label} keep`);
  if (keep.kind === 'invalid') return keep;
  return { kind: 'ok', extension: ext as unknown as BuildExtension };
}

/** `keep`: names Node resolves under `node_modules`, deduplicated and sorted. */
function checkKeep(
  raw: unknown,
  where: string,
):
  | { readonly kind: 'ok'; readonly keep: readonly string[] }
  | { readonly kind: 'invalid'; readonly message: string } {
  if (raw === undefined) return { kind: 'ok', keep: [] };
  if (!Array.isArray(raw)) return invalid(`\`${where}\` must be a list of package names.`);
  for (const name of raw) {
    if (
      typeof name !== 'string' ||
      !KEEP_NAME.test(name) ||
      name.split('/').some((p) => p === '.' || p === '..')
    ) {
      return invalid(
        `\`${where}\`: ${JSON.stringify(name)} isn't a package name (\`name\`, \`@scope/name\`, or a folder such as \`.prisma/client\`).`,
      );
    }
  }
  return { kind: 'ok', keep: [...new Set(raw as string[])].sort() };
}

function checkEnv(
  raw: unknown,
  where: string,
):
  | { readonly kind: 'ok'; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: 'invalid'; readonly message: string } {
  if (raw === undefined) return { kind: 'ok', env: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid(`${where} must be an object of NAME → value.`);
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME.test(name))
      return invalid(`${where}: ${JSON.stringify(name)} isn't an env name.`);
    if (typeof value !== 'string') return invalid(`${where}: ${name} must be a string.`);
  }
  return { kind: 'ok', env: raw as Record<string, string> };
}

function invalid(message: string): { readonly kind: 'invalid'; readonly message: string } {
  return { kind: 'invalid', message };
}
