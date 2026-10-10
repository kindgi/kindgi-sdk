// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PackLanguage } from '@kindgi/handler-runtime';

import { PACK_UV_REQUIRED_VERSION } from '../build/python-image.js';
import type { CommandContext } from '../context.js';
import { writeAgentAccess } from '../init/agent-access.js';
import { runInitAugment } from '../init/augment-scaffolder.js';
import {
  JVM_PREVIEW,
  type KindgiDependencySpecs,
  type KindgiJavaSource,
  kindgiCliRequirement,
  kindgiRequirementFor,
  resolveKindgiDependencySpecs,
  resolveKindgiJavaSource,
  resolveKindgiPythonSource,
  sbtLocalResolver,
} from '../init/dependency-specs.js';
import { runInitJavaAugment } from '../init/java-augment.js';
import { detectInitMode } from '../init/mode-detect.js';
import { runInitPythonAugment } from '../init/python-augment.js';
import { runInitScalaAugment } from '../init/scala-augment.js';
import {
  type RunnerPlaceholders,
  type Substitutions,
  collectTemplateFiles,
  fillRunnerPlaceholders,
  javaPackageOf,
  scalaPackageOf,
  substitute,
  templateTarget,
} from '../init/template-files.js';
import { renderJson } from '../output.js';
import {
  type DetectIo,
  binDisplay,
  cliInstall,
  declaredPackageManager,
  defaultDetectIo,
  installCommand,
  isPackageVersion,
  readPnpmVersion,
  scriptCommand,
  usablePackageManager,
} from '../package-manager.js';
import { resolveSdkPackageRoot } from '../sdk-package.js';
import { CLI_VERSION } from '../version-info.js';
import { syncSkills } from './skills.js';
import type { CommandResult, LeafCommand } from './types.js';

/**
 * `kindgi init <pack-name>` — scaffolds a fresh pack repo.
 *
 * Writes the pack anatomy (config, the four primitives' folders,
 * agent instructions and skills) that the other commands — `dev`,
 * `build`, `deploy`, `test`, `env`, `key` — work on.
 *
 * Templates live under `src/templates/<name>/`. Files ending in `.tmpl`
 * are treated as templates (suffix stripped on write, placeholders
 * substituted); files without the suffix are copied verbatim. Placeholders
 * are simple string replaces — `{{PACK_NAME}}`, `{{PACK_ID}}`,
 * `{{PACK_VERSION}}`. No template engine: the framework's job isn't to be
 * a template engine.
 */
export const initCommand: LeafCommand = {
  kind: 'leaf',
  name: 'init',
  description:
    'Scaffold a new Kindgi pack repo, or add Kindgi to an existing app: a Node.js, Python, Maven or sbt project, auto-detected from its `package.json`, `pyproject.toml`, `pom.xml` or `build.sbt` when no pack-name is given.',
  usage:
    'kindgi init [<pack-name>] [--template=minimal|sample|python|java|scala] [--path=<dir>] [--force] [--link-local] [--new-repo]',
  optionSpec: {
    template: {
      type: 'string',
      description:
        'The starter: `minimal` (default; empty primitive folders), `sample` (tools, a guardrail, an agent and a flow), `python` (a Python pack), `java` (a Java pack, built with Maven; preview) or `scala` (a Scala pack, built with sbt; preview).',
    },
    path: {
      type: 'string',
      description:
        'Where to scaffold. Default: `<pack-name>` (its last dot segment) under the current directory; in an existing app, the current directory.',
    },
    force: {
      type: 'boolean',
      description:
        'Write into a non-empty directory; in an existing app, overwrite the Kindgi config and files already there instead of refusing or skipping them.',
    },
    'link-local': {
      type: 'boolean',
      description:
        'Node packs: link `@kindgi/*` from the Kindgi checkout the CLI runs from, even inside its workspace. No effect for an installed CLI.',
    },
    // Force fresh mode even when a package.json sits at the target
    // dir. Only relevant to disambiguate: someone in an existing repo
    // who wants a NESTED standalone pack rather than augment mode.
    'new-repo': {
      type: 'boolean',
      description:
        'In an existing app, scaffold a separate pack instead of adding Kindgi to the app. Requires `<pack-name>`.',
    },
    // Augment mode only. Override the pack id derived from the
    // surrounding `package.json` `name`. Required if the name can't
    // be normalized to `PACK_ID_REGEX` (underscores, uppercase-only,
    // etc.).
    'pack-id': {
      type: 'string',
      description:
        "Adding Kindgi to an existing app: the pack id, instead of the one derived from the app's name. Needed when that name makes no valid id.",
    },
  },
  run: async (ctx): Promise<CommandResult> =>
    runInit(ctx, defaultTemplatesRoot(), defaultSdkSkillsRoot()),
};

/** Pack ids: lowercase dot-separated segments, e.g. `acme.billing`. */
export const PACK_ID_REGEX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export const AVAILABLE_TEMPLATES = ['minimal', 'sample', 'python', 'java', 'scala'] as const;
export type TemplateName = (typeof AVAILABLE_TEMPLATES)[number];

const DEFAULT_TEMPLATE: TemplateName = 'minimal';
const DEFAULT_PACK_VERSION = '0.1.0';

interface ResolvedArgs {
  readonly packName: string;
  readonly template: TemplateName;
  readonly targetDir: string;
  readonly force: boolean;
  /**
   * When true, rewrites the scaffolded `package.json`'s `workspace:*`
   * `@kindgi/*` deps to `link:<abs-path>` references pointing at
   * the CLI's own monorepo. Lets a pack live OUTSIDE the monorepo
   * while still consuming the workspace SDK as if it were installed
   * from npm. For local dogfooding + real-external-user shape testing.
   */
  readonly linkLocal: boolean;
}

/**
 * Test-friendly entry point — takes an explicit templates root + skills
 * root so tests can point at either the source tree or a temp fixture.
 * `skillsRoot` is optional; when undefined, no skills are copied (the
 * default when the CLI is run from source without a build).
 */
export async function runInit(
  ctx: CommandContext,
  templatesRoot: string,
  skillsRoot?: string,
): Promise<CommandResult> {
  const detected = await detectInitMode({
    cwd: ctx.cwd,
    positionals: ctx.positionals,
    ...(typeof ctx.options.path === 'string' &&
      ctx.options.path !== '' && {
        pathFlag: ctx.options.path,
      }),
    newRepoFlag: ctx.options['new-repo'] === true,
    ...(typeof ctx.options.template === 'string' && { templateFlag: ctx.options.template }),
  });
  if (detected.kind === 'err') {
    return { kind: 'error', stderr: detected.message, exitCode: 1 };
  }

  if (detected.mode === 'augment' && detected.language === 'java') {
    const packIdRaw = ctx.options['pack-id'];
    const template = ctx.options.template;
    if (typeof template === 'string' && template !== '' && template !== 'java') {
      return {
        kind: 'error',
        stderr: `A Maven app gets a Java pack: --template=${template} doesn't apply here (omit it, or --template=java).\n`,
        exitCode: 1,
      };
    }
    return runInitJavaAugment({
      targetDir: detected.targetDir,
      templatesRoot,
      ...(skillsRoot !== undefined && { skillsRoot }),
      ...(typeof packIdRaw === 'string' && packIdRaw !== '' && { packIdOverride: packIdRaw }),
      force: ctx.options.force === true,
    });
  }

  if (detected.mode === 'augment' && detected.language === 'scala') {
    const packIdRaw = ctx.options['pack-id'];
    const template = ctx.options.template;
    if (typeof template === 'string' && template !== '' && template !== 'scala') {
      return {
        kind: 'error',
        stderr: `An sbt app gets a Scala pack: --template=${template} doesn't apply here (omit it, or --template=scala).\n`,
        exitCode: 1,
      };
    }
    return runInitScalaAugment({
      targetDir: detected.targetDir,
      templatesRoot,
      ...(skillsRoot !== undefined && { skillsRoot }),
      ...(typeof packIdRaw === 'string' && packIdRaw !== '' && { packIdOverride: packIdRaw }),
      force: ctx.options.force === true,
    });
  }

  if (detected.mode === 'augment' && detected.language === 'python') {
    const packIdRaw = ctx.options['pack-id'];
    const template = ctx.options.template;
    if (typeof template === 'string' && template !== '' && template !== 'python') {
      return {
        kind: 'error',
        stderr:
          template === 'java'
            ? 'The java template makes a Java pack of its own; this is a Python app, where init adds a Python pack.\nFor a standalone Java pack here: kindgi init <pack-name> --template=java --new-repo\n'
            : `A Python app gets a Python pack: --template=${template} doesn't apply here (omit it, or --template=python).\n`,
        exitCode: 1,
      };
    }
    return runInitPythonAugment({
      targetDir: detected.targetDir,
      ...(skillsRoot !== undefined && { skillsRoot }),
      ...(typeof packIdRaw === 'string' && packIdRaw !== '' && { packIdOverride: packIdRaw }),
      force: ctx.options.force === true,
      pypi: cliInstall(ctx.env) === 'pypi',
    });
  }

  if (detected.mode === 'augment') {
    const packIdRaw = ctx.options['pack-id'];
    const template = augmentTemplate(ctx.options.template);
    if (template.kind === 'err') return { kind: 'error', stderr: template.stderr, exitCode: 1 };
    return runInitAugment({
      targetDir: detected.targetDir,
      template: template.name,
      templatesRoot,
      ...(skillsRoot !== undefined && { skillsRoot }),
      ...(typeof packIdRaw === 'string' && packIdRaw !== '' && { packIdOverride: packIdRaw }),
      force: ctx.options.force === true,
      linkLocal: ctx.options['link-local'] === true,
    });
  }

  return runInitFresh(ctx, templatesRoot, skillsRoot, detected.packName, detected.targetDir);
}

/**
 * The template for augment mode. `sample` adds the sample primitives to
 * the app's `kindgi/` folders; `python` makes a pack of its own, so it
 * doesn't apply to an existing Node app.
 */
function augmentTemplate(
  flag: unknown,
):
  | { readonly kind: 'ok'; readonly name: 'minimal' | 'sample' }
  | { readonly kind: 'err'; readonly stderr: string } {
  const name = typeof flag === 'string' && flag !== '' ? flag : DEFAULT_TEMPLATE;
  if (name === 'minimal' || name === 'sample') return { kind: 'ok', name };
  if (name === 'python') {
    return {
      kind: 'err',
      stderr:
        'The python template makes a Python pack: there is no pyproject.toml here, and in a Node app init adds a TypeScript pack.\nFor a standalone Python pack here: kindgi init <pack-name> --template=python --new-repo\n',
    };
  }
  if (name === 'java' || name === 'scala') {
    const language = name === 'java' ? 'Java' : 'Scala';
    return {
      kind: 'err',
      stderr: `The ${name} template makes a ${language} pack of its own; in a Node app init adds a TypeScript pack.\nFor a standalone ${language} pack here: kindgi init <pack-name> --template=${name} --new-repo\n`,
    };
  }
  return {
    kind: 'err',
    stderr: `Unknown template: ${name}. Available: ${AVAILABLE_TEMPLATES.join(', ')}\n`,
  };
}

/**
 * Fresh-mode scaffold — creates a new pack in a subdirectory. Extracted
 * from `runInit` so the mode-branching entry point stays under the
 * complexity ceiling.
 */
async function runInitFresh(
  ctx: CommandContext,
  templatesRoot: string,
  skillsRoot: string | undefined,
  packName: string,
  targetDir: string,
): Promise<CommandResult> {
  const parsed = resolveFreshArgs(ctx, packName, targetDir);
  if (parsed.kind === 'error') return parsed;
  const args = parsed.args;

  const templateDir = join(templatesRoot, args.template);
  const templateExists = await pathExists(templateDir);
  if (!templateExists) {
    return {
      kind: 'error',
      stderr: `Unknown template: ${args.template}. Available: ${AVAILABLE_TEMPLATES.join(', ')}\n`,
      exitCode: 2,
    };
  }

  const nonEmpty = await isNonEmptyDir(args.targetDir);
  if (nonEmpty && !args.force) {
    return {
      kind: 'error',
      stderr: `Refusing to scaffold into non-empty directory: ${args.targetDir}. Re-run with --force to overwrite.\n`,
      exitCode: 1,
    };
  }

  const languagePack = runInitLanguageTemplate(ctx, args, templatesRoot, templateDir, skillsRoot);
  if (languagePack !== undefined) return languagePack;

  const substitutions: Substitutions = {
    PACK_NAME: args.packName,
    PACK_ID: args.packName,
    PACK_VERSION: DEFAULT_PACK_VERSION,
  };
  const filesWritten = await scaffoldTemplate({
    templateDir,
    targetDir: args.targetDir,
    substitutions,
  });

  // Copy @kindgi/sdk skills into the scaffolded pack's
  // `.claude/skills/`. Claude Code auto-loads these based on their
  // frontmatter `description` — no user action after init.
  const skillsWritten = await copyClaudeSkills({
    skillsRoot,
    targetDir: args.targetDir,
    language: 'node',
  });
  for (const s of skillsWritten) filesWritten.push(s);
  // Keep the coding agent out of the files that hold keys (`init/agent-access.ts`).
  const access = await writeAgentAccess(args.targetDir);
  filesWritten.push(...access.files);

  // A standalone pack pins the pnpm that will install it, so the image
  // (`kindgi build`), CI and a teammate all use that one (T196).
  const runs = ctx.initSeam?.packageManagerRuns;
  const detectIo = { ...defaultDetectIo, ...(runs !== undefined && { runs }) };
  const pnpmPin = await pinStandalonePnpm(ctx, args.targetDir, detectIo);

  // The template pins `@kindgi/sdk` + `@kindgi/cli` as `workspace:*`.
  // Rewrite both to what resolves from here — see `dependency-specs.ts`
  // (workspace inside the Kindgi checkout, `link:` to the checkout from
  // anywhere else or with --link-local, the running CLI's versions once
  // published). The pack then runs its own pinned `kindgi`.
  // The manager that will install it here: the template declares pnpm,
  // but on a machine without pnpm the project installs and runs with npm.
  const packageManager = (await usablePackageManager(args.targetDir, detectIo)).pm;
  const resolvedSpecs = await resolveKindgiDependencySpecs({
    targetDir: args.targetDir,
    packageManager,
    ...(args.linkLocal && { forceLocal: true }),
  });
  if (resolvedSpecs.kind === 'error') {
    return { kind: 'error', stderr: `${resolvedSpecs.message}\n`, exitCode: 1 };
  }
  const specs = resolvedSpecs.specs;
  if (specs.source !== 'workspace') await rewriteTemplateDependencySpecs(args.targetDir, specs);

  // The README's commands are the Next steps' own: the same install and
  // the same `kindgi` runner, for the manager that installs it here.
  const runner = {
    INSTALL: installCommand(packageManager),
    TYPECHECK: scriptCommand(packageManager, 'typecheck'),
    KINDGI: binDisplay(packageManager, 'kindgi'),
  };
  await fillReadmeRunner(args.targetDir, runner);
  const displayPath = relative(ctx.cwd, args.targetDir) || '.';
  const nextSteps = [
    `cd ${displayPath}`,
    runner.INSTALL,
    `${runner.KINDGI} dev  # runs the Kindgi runtime (Docker) + hot-reloads this pack`,
  ];

  const stderr = [
    `✓ Pack scaffolded at ${args.targetDir}/`,
    ...access.lines,
    ...(pnpmPin.kind === 'pinned'
      ? [`✓ package.json pins pnpm@${pnpmPin.version} (packageManager)`]
      : []),
    '',
    'Next steps:',
    ...nextSteps.map((s) => `  ${s}`),
    '',
    ...(pnpmPin.kind === 'unread'
      ? [
          `package.json has no packageManager: pnpm's version couldn't be read here (${pnpmPin.reason}).`,
          'Add "packageManager": "pnpm@<version>" (the pnpm you install with), so kindgi build, CI and teammates use the same pnpm.',
          '',
        ]
      : []),
    "Read the pack's README.md for details.",
    '',
  ].join('\n');

  const payload = {
    template: args.template,
    packId: args.packName,
    packVersion: DEFAULT_PACK_VERSION,
    packageManager,
    ...(pnpmPin.kind === 'pinned' && { packageManagerField: `pnpm@${pnpmPin.version}` }),
    dependencies: specs,
    path: args.targetDir,
    filesWritten: filesWritten.length,
    files: filesWritten.map((p) => relative(args.targetDir, p)),
    nextSteps,
  };

  const rendered = renderJson(payload, ctx.globals.format);
  return {
    kind: 'ok',
    rendered: { stdout: rendered.stdout, stderr },
  };
}

type PnpmPin =
  | { readonly kind: 'pinned'; readonly version: string }
  /** The pack sits inside a project that already says how it installs. */
  | { readonly kind: 'inside' }
  /** pnpm isn't installed here: the pack installs and runs with npm (T280). */
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'unread'; readonly reason: string };

/**
 * A TS template pack that stands alone (nothing at or above its folder
 * names a package manager) gets `"packageManager": "pnpm@<version>"`:
 * the pnpm `pnpm --version` gives in the new pack's folder. Inside an
 * existing project, the project's own setup governs: nothing is written.
 */
async function pinStandalonePnpm(
  ctx: CommandContext,
  packDir: string,
  io: DetectIo,
): Promise<PnpmPin> {
  if ((await declaredPackageManager(dirname(packDir))) !== undefined) return { kind: 'inside' };
  if (io.runs !== undefined && !(await io.runs('pnpm'))) return { kind: 'not-installed' };
  let version: string;
  try {
    version = await (ctx.initSeam?.pnpmVersion ?? readPnpmVersion)(packDir);
  } catch (err) {
    return { kind: 'unread', reason: `pnpm --version: ${(err as Error).message}` };
  }
  if (!isPackageVersion(version)) {
    return { kind: 'unread', reason: `pnpm --version printed "${version}"` };
  }
  const path = join(packDir, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(
    path,
    `${JSON.stringify({ ...manifest, packageManager: `pnpm@${version}` }, null, 2)}\n`,
    'utf8',
  );
  return { kind: 'pinned', version };
}

/**
 * The python template: a Python pack (`[tool.kindgi]` in `pyproject.toml`).
 * No Node project — `kindgi` (Python) comes from PyPI within the CLI's
 * minor, or, for a CLI run from a Kindgi checkout, from that checkout's
 * `sdks/python` (an editable uv source). The skills copied are those
 * written for Python packs.
 */
async function runInitPython(
  ctx: CommandContext,
  args: ResolvedArgs,
  templateDir: string,
  skillsRoot: string | undefined,
): Promise<CommandResult> {
  const source = await resolveKindgiPythonSource();
  if (source.kind === 'error') return { kind: 'error', stderr: `${source.message}\n`, exitCode: 1 };
  const pypi = cliInstall(ctx.env) === 'pypi';
  const block =
    source.kind === 'local-checkout'
      ? [
          '',
          "# From a Kindgi checkout: this pack uses the checkout's Python SDK.",
          '[tool.uv.sources]',
          `kindgi = { path = ${JSON.stringify(source.path)}, editable = true }`,
          '',
        ].join('\n')
      : '';
  // How the pack runs its `kindgi`: `uv run kindgi` with the PyPI CLI in
  // its dev group, else the `kindgi` on PATH. The README says the same.
  const kindgi = binDisplay(pypi ? 'uv' : 'path', 'kindgi');
  const filesWritten = await scaffoldTemplate({
    templateDir,
    targetDir: args.targetDir,
    substitutions: {
      KINDGI: kindgi,
      PACK_NAME: args.packName,
      PACK_ID: args.packName,
      PACK_VERSION: DEFAULT_PACK_VERSION,
      KINDGI_REQUIREMENT: JSON.stringify(kindgiRequirementFor(source)),
      KINDGI_PYTHON_SOURCE: block,
      UV_REQUIRED_VERSION: PACK_UV_REQUIRED_VERSION,
      // From the PyPI CLI, the pack lists it too: `uv run kindgi`, no Node.
      DEV_DEPENDENCIES: [
        '"pytest>=8"',
        ...(pypi ? [JSON.stringify(kindgiCliRequirement(CLI_VERSION))] : []),
      ].join(', '),
    },
  });
  const skillsWritten = await copyClaudeSkills({
    skillsRoot,
    targetDir: args.targetDir,
    language: 'python',
  });
  for (const s of skillsWritten) filesWritten.push(s);
  // Keep the coding agent out of the files that hold keys (`init/agent-access.ts`).
  const access = await writeAgentAccess(args.targetDir);
  filesWritten.push(...access.files);
  const displayPath = relative(ctx.cwd, args.targetDir) || '.';
  const nextSteps = [
    `cd ${displayPath}`,
    `uv sync  # .venv with kindgi${pypi ? ' and the kindgi CLI' : ''}`,
    'uv run pytest',
    `${kindgi} dev  # boots Kindgi locally + runs this pack with its .venv, reloading on save`,
  ];
  const stderr = [
    `✓ Python pack scaffolded at ${args.targetDir}/`,
    ...access.lines,
    '',
    'Next steps:',
    ...nextSteps.map((s) => `  ${s}`),
    '',
    "Read the pack's README.md for details.",
    '',
  ].join('\n');
  const rendered = renderJson(
    {
      template: args.template,
      packId: args.packName,
      packVersion: DEFAULT_PACK_VERSION,
      kindgi: source,
      path: args.targetDir,
      filesWritten: filesWritten.length,
      files: filesWritten.map((p) => relative(args.targetDir, p)),
      nextSteps,
    },
    ctx.globals.format,
  );
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr } };
}

/**
 * The java template: a Maven project (`pom.xml` with `com.kindgi:kindgi-pack`
 * at this CLI's version, the Maven wrapper) whose sources sit under a
 * package named from the pack id. kindgi-pack comes from Maven Central; from a
 * Kindgi checkout, the next steps install the checkout's `sdks/java` into the
 * local Maven repository first.
 */
async function runInitJava(
  ctx: CommandContext,
  args: ResolvedArgs,
  templateDir: string,
  skillsRoot: string | undefined,
): Promise<CommandResult> {
  const source = await resolveKindgiJavaSource();
  if (source.kind === 'error') return { kind: 'error', stderr: `${source.message}\n`, exitCode: 1 };
  const javaPackage = javaPackageOf(args.packName);
  const filesWritten = await scaffoldTemplate({
    templateDir,
    targetDir: args.targetDir,
    substitutions: {
      PACK_NAME: args.packName,
      PACK_ID: args.packName,
      PACK_VERSION: DEFAULT_PACK_VERSION,
      JAVA_PACKAGE: javaPackage,
      JAVA_PACKAGE_PATH: javaPackage.split('.').join('/'),
      KINDGI_JAVA_VERSION: source.version,
      KINDGI_CLI_VERSION: CLI_VERSION,
    },
  });
  const skillsWritten = await copyClaudeSkills({
    skillsRoot,
    targetDir: args.targetDir,
    language: 'java',
  });
  for (const s of skillsWritten) filesWritten.push(s);
  // Keep the coding agent out of the files that hold keys (`init/agent-access.ts`).
  const access = await writeAgentAccess(args.targetDir);
  filesWritten.push(...access.files);
  const displayPath = relative(ctx.cwd, args.targetDir) || '.';
  const install =
    source.kind === 'local-checkout'
      ? [
          `(cd ${source.path} && ./mvnw -q install -DskipTests)  # kindgi-pack ${source.version} into your local Maven repository`,
        ]
      : [];
  const nextSteps = [
    ...install,
    `cd ${displayPath}`,
    './mvnw test',
    `${binDisplay('kindgiw', 'kindgi', ['dev'])}  # the CLI the pack pins (kindgi.config.json "cli"): boots Kindgi locally + compiles and runs this pack, recompiling on save`,
  ];
  const stderr = [
    `✓ Java pack scaffolded at ${args.targetDir}/ (preview)`,
    ...access.lines,
    `  ${JVM_PREVIEW}`,
    '',
    'Next steps (a JDK 17 or later, JAVA_HOME set):',
    ...nextSteps.map((s) => `  ${s}`),
    '',
    "Read the pack's README.md for details.",
    '',
  ].join('\n');
  const rendered = renderJson(
    {
      template: args.template,
      packId: args.packName,
      packVersion: DEFAULT_PACK_VERSION,
      javaPackage,
      kindgiPack: source,
      preview: true,
      path: args.targetDir,
      filesWritten: filesWritten.length,
      files: filesWritten.map((p) => relative(args.targetDir, p)),
      nextSteps,
    },
    ctx.globals.format,
  );
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr } };
}

/** A pack of another language than TypeScript (Python, Java, Scala); undefined for a TypeScript template. */
function runInitLanguageTemplate(
  ctx: CommandContext,
  args: ResolvedArgs,
  templatesRoot: string,
  templateDir: string,
  skillsRoot: string | undefined,
): Promise<CommandResult> | undefined {
  switch (args.template) {
    case 'python':
      return runInitPython(ctx, args, templateDir, skillsRoot);
    case 'java':
      return runInitJava(ctx, args, templateDir, skillsRoot);
    case 'scala':
      return runInitScala(ctx, args, templatesRoot, templateDir, skillsRoot);
    default:
      return undefined;
  }
}

/** build.sbt's resolver line for kindgi-pack from a checkout (the local Maven repository); none from Maven Central. */
function scalaTemplateResolver(source: KindgiJavaSource): string {
  const resolver = sbtLocalResolver(source);
  return resolver === undefined
    ? ''
    : `\n    // kindgi-pack from the Kindgi checkout this pack was made from (./mvnw install).\n    ${resolver},`;
}

/**
 * A Scala pack (`--template=scala`): sbt, kindgi-pack-scala, the `kindgiw`
 * wrappers (the java template's) that run the CLI the pack pins.
 * kindgi-pack-scala comes from Maven Central; from a Kindgi checkout, the next
 * steps publish the checkout's (and kindgi-pack, which it builds on) locally
 * first, and the build reads the local Maven repository.
 */
async function runInitScala(
  ctx: CommandContext,
  args: ResolvedArgs,
  templatesRoot: string,
  templateDir: string,
  skillsRoot: string | undefined,
): Promise<CommandResult> {
  const source = await resolveKindgiJavaSource();
  if (source.kind === 'error') return { kind: 'error', stderr: `${source.message}\n`, exitCode: 1 };
  const scalaPackage = scalaPackageOf(args.packName);
  const filesWritten = await scaffoldTemplate({
    templateDir,
    targetDir: args.targetDir,
    substitutions: {
      PACK_NAME: args.packName,
      PACK_ID: args.packName,
      PACK_VERSION: DEFAULT_PACK_VERSION,
      SCALA_PACKAGE: scalaPackage,
      SCALA_PACKAGE_PATH: scalaPackage.split('.').join('/'),
      KINDGI_SCALA_VERSION: source.version,
      SCALA_LOCAL_RESOLVER: scalaTemplateResolver(source),
      KINDGI_CLI_VERSION: CLI_VERSION,
    },
  });
  for (const wrapper of ['kindgiw', 'kindgiw.cmd']) {
    const dest = join(args.targetDir, wrapper);
    await writeFile(dest, await readFile(join(templatesRoot, 'java', wrapper)));
    if (wrapper === 'kindgiw') await chmod(dest, 0o755);
    filesWritten.push(dest);
  }
  for (const s of await copyClaudeSkills({
    skillsRoot,
    targetDir: args.targetDir,
    language: 'scala',
  })) {
    filesWritten.push(s);
  }
  // Keep the coding agent out of the files that hold keys (`init/agent-access.ts`).
  const access = await writeAgentAccess(args.targetDir);
  filesWritten.push(...access.files);
  filesWritten.sort();
  const displayPath = relative(ctx.cwd, args.targetDir) || '.';
  const install =
    source.kind === 'local-checkout'
      ? [
          `(cd ${source.path} && ./mvnw -q -pl kindgi-pack -am install -DskipTests)  # kindgi-pack ${source.version} into your local Maven repository`,
          `(cd ${join(source.path, '..', 'scala')} && sbt +publishLocal)  # kindgi-pack-scala ${source.version} into your local Ivy repository`,
        ]
      : [];
  const nextSteps = [
    ...install,
    `cd ${displayPath}`,
    'sbt test',
    `${binDisplay('kindgiw', 'kindgi', ['dev'])}  # the CLI the pack pins (kindgi.config.json "cli"): boots Kindgi locally + compiles and runs this pack, recompiling on save`,
  ];
  const stderr = [
    `✓ Scala pack scaffolded at ${args.targetDir}/ (preview)`,
    ...access.lines,
    `  ${JVM_PREVIEW}`,
    '',
    'Next steps (a JDK 17 or later, JAVA_HOME set, and sbt):',
    ...nextSteps.map((s) => `  ${s}`),
    '',
    "Read the pack's README.md for details.",
    '',
  ].join('\n');
  const rendered = renderJson(
    {
      template: args.template,
      packId: args.packName,
      packVersion: DEFAULT_PACK_VERSION,
      scalaPackage,
      kindgiPack: source,
      preview: true,
      path: args.targetDir,
      filesWritten: filesWritten.length,
      files: filesWritten.map((p) => relative(args.targetDir, p)),
      nextSteps,
    },
    ctx.globals.format,
  );
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr } };
}

type ArgsOutcome =
  | { readonly kind: 'ok'; readonly args: ResolvedArgs }
  | (CommandResult & { readonly kind: 'error' });

function resolveFreshArgs(ctx: CommandContext, packName: string, targetDir: string): ArgsOutcome {
  if (!PACK_ID_REGEX.test(packName)) {
    return {
      kind: 'error',
      stderr: `Invalid pack-name: ${packName}. Pack IDs must match ${PACK_ID_REGEX.source} (lowercase kebab, optionally dot-namespaced — e.g., my-pack or acme.legal-basics).\n`,
      exitCode: 1,
    };
  }
  const templateFlag = ctx.options.template;
  const templateInput =
    typeof templateFlag === 'string' && templateFlag !== '' ? templateFlag : DEFAULT_TEMPLATE;
  if (!(AVAILABLE_TEMPLATES as readonly string[]).includes(templateInput)) {
    return {
      kind: 'error',
      stderr: `Unknown template: ${templateInput}. Available: ${AVAILABLE_TEMPLATES.join(', ')}\n`,
      exitCode: 2,
    };
  }
  const force = ctx.options.force === true;
  const linkLocal = ctx.options['link-local'] === true;
  return {
    kind: 'ok',
    args: {
      packName,
      template: templateInput as TemplateName,
      targetDir,
      force,
      linkLocal,
    },
  };
}

/** Fill the README's runner placeholders, once the package manager is known. */
async function fillReadmeRunner(targetDir: string, runner: RunnerPlaceholders): Promise<void> {
  const path = join(targetDir, 'README.md');
  if (!existsSync(path)) return;
  await writeFile(path, fillRunnerPlaceholders(await readFile(path, 'utf8'), runner), 'utf8');
}

async function scaffoldTemplate(inputs: {
  readonly templateDir: string;
  readonly targetDir: string;
  readonly substitutions: Substitutions;
}): Promise<string[]> {
  const files = await collectTemplateFiles(inputs.templateDir);
  const written: string[] = [];
  for (const rel of files) {
    const src = join(inputs.templateDir, rel);
    const dest = join(
      inputs.targetDir,
      templateTarget(
        rel,
        inputs.substitutions.JAVA_PACKAGE_PATH ?? inputs.substitutions.SCALA_PACKAGE_PATH,
      ),
    );
    await mkdir(dirname(dest), { recursive: true });
    if (rel.endsWith('.tmpl')) {
      const raw = await readFile(src, 'utf8');
      const rendered = substitute(raw, inputs.substitutions);
      await writeFile(dest, rendered, 'utf8');
    } else {
      const bytes = await readFile(src);
      await writeFile(dest, bytes);
      // The wrappers run as programs (npm drops the template's own mode).
      if (basename(dest) === 'mvnw' || basename(dest) === 'kindgiw') await chmod(dest, 0o755);
    }
    written.push(dest);
  }
  written.sort();
  return written;
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Stamp the resolved specs over the template's `workspace:*` entries
 * for `@kindgi/sdk` (dependencies) and `@kindgi/cli` (devDependencies).
 */
async function rewriteTemplateDependencySpecs(
  targetDir: string,
  specs: KindgiDependencySpecs,
): Promise<void> {
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (pkg.dependencies?.['@kindgi/sdk'] !== undefined) pkg.dependencies['@kindgi/sdk'] = specs.sdk;
  if (pkg.devDependencies?.['@kindgi/cli'] !== undefined) {
    pkg.devDependencies['@kindgi/cli'] = specs.cli;
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

export function defaultTemplatesRoot(): string {
  return fileURLToPath(new URL('../templates/', import.meta.url));
}

/**
 * Absolute path to the bundled `@kindgi/sdk` skills the CLI copies
 * into the scaffolded pack's `.claude/skills/`. Two candidate
 * locations, checked in order:
 *
 *  1. `../sdk-skills/` relative to this file — the built form, where
 *     `scripts/copy-build-assets.mjs` bundled the skills at CLI build.
 *  2. `skills/` inside the resolved `@kindgi/sdk` package — the source
 *     form, used when running the CLI from source (tests,
 *     `pnpm --filter @kindgi/cli test`). Resolved by package name, so it
 *     works in any repo layout.
 *
 * Returns `undefined` when neither exists — a broken install; callers
 * scaffold the pack without skills.
 */
export function defaultSdkSkillsRoot(): string | undefined {
  const built = fileURLToPath(new URL('../sdk-skills/', import.meta.url));
  if (existsSync(built)) return built;
  const sdkRoot = resolveSdkPackageRoot();
  if (sdkRoot !== undefined && existsSync(join(sdkRoot, 'skills'))) return join(sdkRoot, 'skills');
  return undefined;
}

/**
 * Copy every `<skill-name>/SKILL.md` written for packs in `language`
 * from `skillsRoot` into `<targetDir>/.claude/skills/<skill-name>/SKILL.md`. Claude Code
 * auto-loads skills from `.claude/skills/` based on their
 * frontmatter `description` — no user action required after init.
 *
 * Silently no-ops when `skillsRoot` is undefined (source-run CLI
 * without a build).
 */
async function copyClaudeSkills(inputs: {
  readonly skillsRoot: string | undefined;
  readonly targetDir: string;
  readonly language: PackLanguage;
}): Promise<string[]> {
  if (inputs.skillsRoot === undefined) return [];
  // Same path as `kindgi skills sync`, so its manifest is written and
  // `kindgi dev` doesn't report freshly installed skills as out of date.
  const report = await syncSkills({
    skillsRoot: inputs.skillsRoot,
    targetDir: inputs.targetDir,
    language: inputs.language,
    force: true,
    dryRun: false,
  });
  return report.outcomes
    .filter((o) => o.status === 'added' || o.status === 'updated')
    .map((o) => join(inputs.targetDir, '.claude', 'skills', o.name, 'SKILL.md'));
}
