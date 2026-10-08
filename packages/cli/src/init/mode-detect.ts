// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` mode-detection — routes between two flows:
 *
 *   - **fresh** — creates a new pack in a subdirectory, scaffolds the
 *     full template (`package.json`, `tsconfig.json`,
 *     `pnpm-workspace.yaml`, `agents/`, `tools/`, etc.). The
 *     historical `kindgi init <pack-name>` shape.
 *   - **augment** — adds Kindgi files alongside an existing project: a
 *     Node.js app (`kindgi.config.ts`, `kindgi/**`, `.claude/skills/`, the
 *     existing `package.json` patched — "add Kindgi to my Next.js app")
 *     or a Python app (`[tool.kindgi]` appended to its `pyproject.toml`,
 *     `kindgi/**`, the Python-pack skills).
 *
 * Detection rules (in evaluation order):
 *
 *   1. `--new-repo` explicit: fresh mode (positional pack-name still
 *      required). Escape hatch for "I'm in a repo but want a nested
 *      standalone pack anyway."
 *   2. Positional pack-name present: fresh mode. Intent signal wins.
 *   3. No positional AND `package.json` at target dir: augment mode, a
 *      TypeScript pack — unless `--template=python` and a
 *      `pyproject.toml` is there too (an app with both).
 *   4. No positional AND a `pyproject.toml` (no `package.json`): augment
 *      mode, a Python pack.
 *   5. Neither: error — caller either wants fresh (needs pack-name) or
 *      augment (needs a package.json or pyproject.toml in scope).
 *
 * The result carries the resolved `targetDir` so callers don't
 * re-resolve `--path` themselves; consistent path handling in one
 * place.
 */

import { isAbsolute, resolve } from 'node:path';

export type InitMode = 'fresh' | 'augment';

export interface DetectInputs {
  readonly cwd: string;
  readonly positionals: readonly string[];
  /** `--path=<dir>` — target directory. Absolute or cwd-relative. */
  readonly pathFlag?: string;
  /**
   * `--new-repo` — force fresh mode even when a `package.json` sits
   * at the target dir. Rare but real: someone in a monorepo wants to
   * scaffold a standalone pack in a nested subdir.
   */
  readonly newRepoFlag: boolean;
  /** `--template=<name>` — `python` or `java` picks that app when several project files exist. */
  readonly templateFlag?: string;
  /** Test injection point. */
  readonly fileExists?: (path: string) => Promise<boolean>;
}

export type DetectResult =
  | {
      readonly kind: 'ok';
      readonly mode: 'fresh';
      readonly targetDir: string;
      readonly packName: string;
    }
  | {
      readonly kind: 'ok';
      readonly mode: 'augment';
      readonly targetDir: string;
      /** The app's language — the pack's. */
      readonly language: 'node' | 'python' | 'java';
    }
  | {
      readonly kind: 'err';
      readonly message: string;
    };

const defaultFileExists = async (path: string): Promise<boolean> => {
  const { stat } = await import('node:fs/promises');
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
};

export async function detectInitMode(inputs: DetectInputs): Promise<DetectResult> {
  const fileExists = inputs.fileExists ?? defaultFileExists;
  const packName = inputs.positionals[0] ?? '';

  // Resolve targetDir:
  //   - fresh mode: --path defaults to `<cwd>/<packName>` (or `<cwd>/<lastDot>` for dot-namespaced ids)
  //   - augment mode: --path defaults to `<cwd>`
  // For DETECTION we only care about the dir we'll look for `package.json` in.
  // In fresh mode with a positional pack-name we look at the PARENT (cwd) not the target subdir.
  // In augment mode we look at the resolved `--path` or cwd.

  // Case 1: --new-repo forces fresh. Positional required.
  if (inputs.newRepoFlag) {
    if (packName === '') {
      return {
        kind: 'err',
        message:
          '--new-repo requires a pack-name.\n' +
          'Usage: kindgi init <pack-name> --new-repo [--path=<dir>]\n',
      };
    }
    return {
      kind: 'ok',
      mode: 'fresh',
      targetDir: resolveFreshTargetDir(inputs.cwd, inputs.pathFlag, packName),
      packName,
    };
  }

  // Case 2: positional pack-name present. Fresh mode (intent signal).
  if (packName !== '') {
    return {
      kind: 'ok',
      mode: 'fresh',
      targetDir: resolveFreshTargetDir(inputs.cwd, inputs.pathFlag, packName),
      packName,
    };
  }

  // No positional — detect based on package.json presence.
  const augmentTargetDir =
    inputs.pathFlag !== undefined && inputs.pathFlag !== ''
      ? isAbsolute(inputs.pathFlag)
        ? inputs.pathFlag
        : resolve(inputs.cwd, inputs.pathFlag)
      : inputs.cwd;

  const hasPackageJson = await fileExists(`${augmentTargetDir}/package.json`);
  const hasPyproject = await fileExists(`${augmentTargetDir}/pyproject.toml`);
  const hasPom = await fileExists(`${augmentTargetDir}/pom.xml`);

  // A Maven app: alone, or picked with --template=java.
  if (hasPom && ((!hasPackageJson && !hasPyproject) || inputs.templateFlag === 'java')) {
    return { kind: 'ok', mode: 'augment', targetDir: augmentTargetDir, language: 'java' };
  }

  // Cases 3 and 4: no positional + a project file → augment, in its language.
  if (hasPyproject && (!hasPackageJson || inputs.templateFlag === 'python')) {
    return { kind: 'ok', mode: 'augment', targetDir: augmentTargetDir, language: 'python' };
  }
  if (hasPackageJson) {
    return { kind: 'ok', mode: 'augment', targetDir: augmentTargetDir, language: 'node' };
  }

  // Case 5: no positional + neither → error.
  return {
    kind: 'err',
    message: `No pack-name provided and no package.json, pyproject.toml or pom.xml at ${augmentTargetDir}.\n  - To scaffold a new pack:      kindgi init <pack-name> [--template=python|java]\n  - To add Kindgi to existing:   run inside a directory with package.json (Node), pyproject.toml (Python) or pom.xml (Java, Maven)\n`,
  };
}

/**
 * Fresh-mode target dir resolution — matches the historical behavior
 * of `resolveArgs` in `init.ts`. If `--path` is set, use it verbatim
 * (absolute or cwd-relative). Otherwise default to `<cwd>/<dirName>`
 * where dirName strips the namespace prefix of dot-namespaced ids
 * (`acme.legal-basics` → `legal-basics`).
 */
function resolveFreshTargetDir(
  cwd: string,
  pathFlag: string | undefined,
  packName: string,
): string {
  if (pathFlag !== undefined && pathFlag !== '') {
    return isAbsolute(pathFlag) ? pathFlag : resolve(cwd, pathFlag);
  }
  const dotIdx = packName.lastIndexOf('.');
  const dirName = dotIdx === -1 ? packName : packName.slice(dotIdx + 1);
  return resolve(cwd, dirName);
}
