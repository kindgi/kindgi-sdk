// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Does the reference cover everything Kindgi has? Compares the generated
 * lists (the CLI's commands and flags, the env schema's variables, the
 * API's error codes and operations) with the reference's entries, and
 * returns every gap as a sentence. No gaps: an empty list.
 *
 * Every entry needs each part of the reference layout: synopsis,
 * description, options with their defaults, examples, see also. The
 * parts that come from Kindgi's sources are there by construction; the
 * hand-written parts (`entries/*.mjs`) and the parts that come from the
 * guides are what can be missing. An entry for something that's gone is a
 * gap too, so the entries can't outlive what they describe.
 */

/**
 * @param {object} input
 * @param {{ path: string, runnable: boolean, usage?: string, description: string,
 *   flags: { name: string, type: string, default?: string }[],
 *   examples: number, seeAlso: number }[]} input.commands
 * @param {{ name: string, type: string, default?: string }[]} input.globalFlags
 * @param {{ name: string, description: string, default?: string, example?: string,
 *   seeAlso: number }[]} input.envVars
 * @param {{ code: string, description?: string, details?: unknown[], seeAlso: number }[]} input.errorCodes
 * @param {{ slug: string, seeAlso: number }[]} input.operations
 * @param {object} input.entries the hand-written entries' keys, to find stale ones
 * @param {string[]} input.entries.cliDefaults `command flag` for each flag default written
 * @param {string[]} input.entries.cliExamples command paths with written examples
 * @param {string[]} input.entries.cliGroups top-level commands with written "see also"
 * @param {string[]} input.entries.globalDefaults global flag names with a written default
 * @param {string[]} input.entries.envDefaults variables with a written default
 * @param {string[]} input.entries.envExamples variables with a written example
 * @param {string[]} input.entries.envGroups env groups with written "see also"
 * @param {string[]} input.entries.errors codes with a written entry
 * @param {string[]} input.envGroupNames the env schema's groups
 */
export function referenceGaps(input) {
  const gaps = [];
  const { commands, globalFlags, envVars, errorCodes, operations, entries } = input;

  for (const command of commands) {
    const name = `kindgi ${command.path}`;
    if (!command.description) gaps.push(`${name}: no description`);
    if (command.runnable && !command.usage) gaps.push(`${name}: no synopsis (usage)`);
    for (const flag of command.flags) {
      if (flag.default === undefined) gaps.push(`${name} --${flag.name}: no default stated`);
    }
    if (command.runnable && command.examples === 0) gaps.push(`${name}: no example`);
    if (command.seeAlso === 0) gaps.push(`${name}: no "see also"`);
  }
  for (const flag of globalFlags) {
    if (flag.default === undefined) gaps.push(`global flag --${flag.name}: no default stated`);
  }
  for (const variable of envVars) {
    if (!variable.description) gaps.push(`${variable.name}: no description`);
    if (variable.default === undefined) gaps.push(`${variable.name}: no default stated`);
    if (!variable.example) gaps.push(`${variable.name}: no example`);
    if (variable.seeAlso === 0) gaps.push(`${variable.name}: no "see also"`);
  }
  for (const error of errorCodes) {
    if (!error.description) gaps.push(`error code ${error.code}: no description`);
    if (!Array.isArray(error.details)) gaps.push(`error code ${error.code}: details not stated`);
    if (error.seeAlso === 0) gaps.push(`error code ${error.code}: no "see also"`);
  }
  for (const operation of operations) {
    if (operation.seeAlso === 0) gaps.push(`${operation.slug}: no "see also"`);
  }

  // Entries for what's gone.
  const flagKeys = new Set(
    commands.flatMap((command) => command.flags.map((flag) => `${command.path} ${flag.name}`)),
  );
  const paths = new Set(commands.map((command) => command.path));
  const runnable = new Set(commands.filter((c) => c.runnable).map((command) => command.path));
  const tops = new Set(commands.map((command) => command.path.split(' ')[0]));
  const globals = new Set(globalFlags.map((flag) => flag.name));
  const vars = new Set(envVars.map((variable) => variable.name));
  const codes = new Set(errorCodes.map((error) => error.code));
  const stale = (list, known, what) => {
    for (const key of list)
      if (!known.has(key)) gaps.push(`${what} ${key}: an entry for something that's gone`);
  };
  stale(entries.cliDefaults, flagKeys, 'flag default');
  stale(entries.cliExamples, runnable, 'example for');
  stale(entries.cliGroups, tops, '"see also" for command group');
  stale(entries.globalDefaults, globals, 'global flag default');
  stale(entries.envDefaults, vars, 'default for');
  stale(entries.envExamples, vars, 'example for');
  stale(entries.envGroups, new Set(input.envGroupNames), '"see also" for env group');
  stale(entries.errors, codes, 'error code');
  if (paths.size !== commands.length) gaps.push('two CLI commands share a path');
  return gaps;
}
