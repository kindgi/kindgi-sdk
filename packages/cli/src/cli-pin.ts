// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi CLI version a Java pack pins: `"cli"` in its
 * `kindgi.config.json`, the single source of truth its `kindgiw` wrapper
 * runs. (A TypeScript pack pins the CLI in `package.json`, a Python pack in
 * its dev dependencies.) A command run in the pack with another CLI says so;
 * `kindgi upgrade` moves the pin.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { KINDGI_JSON_CONFIG_FILENAME } from '@kindgi/handler-runtime';

/** The key in `kindgi.config.json`. */
export const CLI_PIN_KEY = 'cli';

/** A version the pin can hold: `major.minor.patch`, with an optional pre-release. */
export const PINNABLE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The pinned version in `<dir>/kindgi.config.json`; `undefined` without the file or the key. */
export async function readCliPin(dir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, KINDGI_JSON_CONFIG_FILENAME), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const pin = (JSON.parse(text) as Record<string, unknown>)[CLI_PIN_KEY];
    return typeof pin === 'string' && pin !== '' ? pin : undefined;
  } catch {
    return undefined; // the config loader reports a file that isn't JSON
  }
}

/** One line when the running CLI isn't the pinned one; `undefined` when it is. */
export function cliPinWarning(pin: string, running: string): string | undefined {
  if (pin === running) return undefined;
  return (
    `⚠ This pack pins the Kindgi CLI ${pin} ("${CLI_PIN_KEY}" in ${KINDGI_JSON_CONFIG_FILENAME}), and this is ${running}. ` +
    `Run it as ./kindgiw <command>, or move the pin with: kindgi upgrade\n`
  );
}

/**
 * Sets the pin in a `kindgi.config.json`, keeping its other keys in order
 * (a new key goes after `language`). Returns the previous pin.
 */
export async function writeCliPin(
  configPath: string,
  version: string,
): Promise<{ readonly previous?: string }> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const previous =
    typeof config[CLI_PIN_KEY] === 'string' ? (config[CLI_PIN_KEY] as string) : undefined;
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(config)) {
    if (key === CLI_PIN_KEY) {
      out[key] = version;
      placed = true;
      continue;
    }
    out[key] = value;
    if (key === 'language' && !(CLI_PIN_KEY in config)) {
      out[CLI_PIN_KEY] = version;
      placed = true;
    }
  }
  if (!placed) out[CLI_PIN_KEY] = version;
  await writeFile(configPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return previous === undefined ? {} : { previous };
}
