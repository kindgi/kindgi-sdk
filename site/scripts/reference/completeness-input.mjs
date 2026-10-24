// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Builds `referenceGaps`' input from the generated lists, the entries and
 * the generator's own functions for each part (passed in `parts`, so the
 * check counts what the pages show).
 */
export function completenessInput(sources) {
  const { commands, globalFlags, envSchema, codes, errorEntries, operations } = sources;
  const { cliEntries, envEntries, parts } = sources;
  return {
    commands: commands.map((command) => {
      const runnable = command.subcommands.length === 0;
      const path = command.path.join(' ');
      return {
        path,
        runnable,
        usage: command.usage,
        description: command.description,
        flags: command.flags.map((flag) => ({ ...flag, default: parts.flagDefault(path, flag) })),
        examples: runnable ? parts.commandExamples(command) : 0,
        seeAlso: parts.commandSeeAlso(command, `reference/cli/${command.path[0]}`),
      };
    }),
    globalFlags: globalFlags.map((flag) => ({
      ...flag,
      default: parts.flagDefault(undefined, flag),
    })),
    envVars: envSchema.map((variable) => ({
      name: variable.name,
      description: variable.description,
      default: parts.envDefault(variable),
      example: parts.envExample(variable),
      seeAlso: parts.envSeeAlso(variable),
    })),
    errorCodes: codes.map((code) => ({
      code,
      description: errorEntries[code]?.description,
      details: errorEntries[code]?.details,
      seeAlso: parts.codeSeeAlso(code),
    })),
    operations: operations.map((operation) => ({
      slug: operation.slug,
      seeAlso: sources.apiSeeAlso[operation.slug]?.length ?? 0,
    })),
    entries: {
      cliDefaults: Object.entries(cliEntries.CLI_DEFAULTS).flatMap(([path, flags]) =>
        Object.keys(flags).map((flag) => `${path} ${flag}`),
      ),
      cliExamples: Object.keys(cliEntries.CLI_EXAMPLES),
      cliGroups: Object.keys(cliEntries.CLI_GROUP_SEE_ALSO),
      globalDefaults: Object.keys(cliEntries.GLOBAL_FLAG_DEFAULTS),
      envDefaults: Object.keys(envEntries.ENV_DEFAULTS),
      envExamples: Object.keys(envEntries.ENV_EXAMPLES),
      envGroups: Object.keys(envEntries.ENV_GROUP_SEE_ALSO),
      errors: Object.keys(errorEntries),
    },
    envGroupNames: sources.envGroupNames,
  };
}
