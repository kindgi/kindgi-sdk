// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Which of a pack's files git hasn't committed: what `kindgi dev` tells a
 * pin before it writes over them (`POST /v1/blocks/uncommitted` on its
 * pack service front). A file is uncommitted when `git status` lists it:
 * changed, staged, untracked or ignored. What it holds then is in no
 * commit, so git can't bring it back once it's written over. So is a file
 * that's there but neither listed nor in the index (`ls-files --cached`):
 * it's in another repository inside this one, a submodule say, which this
 * repository's git doesn't hold either.
 *
 * The files are paths in the pack's folder. Each is read `/`-separated (a
 * `\` read as one) and normalized, as git names it, and is answered so.
 * One that isn't a file in the pack's folder (empty, absolute, outside it,
 * a folder, or with a NUL) answers `unknown`, with no git command run.
 *
 * Read-only, in the pack's folder, with no shell, by the path `git.ts`'s
 * `findOnPath` finds on `PATH`: never a `git` in the pack's folder.
 * `rev-parse --show-prefix`
 * says where the pack's folder sits in its repository, since `status`
 * names files from the repository's root, which may be above it. `status`
 * then reads only the files asked about, named as literal paths, with each
 * untracked and ignored file listed on its own rather than its folder, and
 * `ls-files` which of them the index holds. Neither takes the repository's
 * index lock (`--no-optional-locks`), so they can't get in the way of a
 * git command the person runs meanwhile. Git's repository variables
 * (`GIT_DIR` and the rest) are left out of their environment, so the
 * pack's folder is the repository they read, as `deploy/source.ts` reads
 * it for a deploy.
 *
 * Only git's own "not a git repository (or any ...)", from looking for a
 * repository above the folder, is `not-in-git`. No git, a git that didn't
 * answer in time, and any other refusal (a repository whose owner git
 * doesn't trust, or a worktree whose repository moved, say) are `unknown`:
 * nothing is said then.
 */

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { findOnPath } from './git.js';

/**
 * What git says of some of a pack's files: `git`, with those it hasn't
 * committed as they are, relative to the pack's folder as git names them,
 * and sorted;
 * `not-in-git`, the pack's folder isn't in a git repository; `unknown`,
 * git couldn't say.
 */
export type FilesInGit =
  | { readonly kind: 'git'; readonly uncommitted: readonly string[] }
  | { readonly kind: 'not-in-git' }
  | { readonly kind: 'unknown' };

/** How long each git command may take before it's killed and nothing is said. */
const GIT_TIMEOUT_MS = 2_000;
/** More than `status` prints for the files of one pin. */
const GIT_MAX_BUFFER = 1024 * 1024;

/**
 * The variables that point git at a repository, as
 * `git rev-parse --local-env-vars` lists them: set in the shell `kindgi dev`
 * runs in, they'd make git read another repository than the pack's.
 */
const REPOSITORY_VARS: ReadonlySet<string> = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/** What a git command answered: what it printed, that there's no repository, or that it failed. */
export type GitAnswer =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'not-a-repository' }
  | { readonly kind: 'failed' };

/** `git <args>` run in `cwd`, killed past `timeoutMs`. */
export type GitCall = (
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<GitAnswer>;

/**
 * A `GitCall` that runs the `git` `findOnPath` finds on `env`'s `PATH`, by
 * that path, in `env` less git's repository variables and with its
 * messages in English, which it reads. With no git there, it failed.
 */
export function gitCaller(env: Readonly<Record<string, string | undefined>>): GitCall {
  return async (cwd, args, timeoutMs) => {
    // Looked for on the PATH it then runs with.
    const childEnv = gitEnv(env);
    const git = await findOnPath('git', childEnv);
    if (git === undefined) return { kind: 'failed' };
    return new Promise((resolve) => {
      try {
        execFile(
          git,
          [...args],
          {
            cwd,
            env: childEnv,
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: GIT_MAX_BUFFER,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            if (err === null) return resolve({ kind: 'ok', stdout });
            // Git exits 128 for every fatal error. Only looking for a repository
            // and finding none says this; a broken `.git` file says less.
            const noRepository = err.code === 128 && /not a git repository \(or any/.test(stderr);
            resolve(noRepository ? { kind: 'not-a-repository' } : { kind: 'failed' });
          },
        );
      } catch {
        // An argument execFile can't pass (one with a NUL) throws.
        resolve({ kind: 'failed' });
      }
    });
  };
}

/** `gitCaller` on this process's environment, as it is at each call. */
export const callGit: GitCall = gitCaller(process.env);

/**
 * `env` without git's repository variables, with git's messages in English:
 * for any git command on the pack's folder, so it reads that repository.
 */
export function gitEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(
    Object.entries(env).filter(([name]) => !REPOSITORY_VARS.has(name)),
  );
  return { ...kept, LC_ALL: 'C' };
}

/**
 * Which of `files` (relative to `packDir`) git hasn't committed, or that
 * `packDir` isn't in a git repository, or `unknown`.
 */
export async function uncommittedFiles(
  packDir: string,
  files: readonly string[],
  git: GitCall = callGit,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<FilesInGit> {
  const asked = packPaths(files);
  if (asked === undefined) return { kind: 'unknown' };
  const where = await git(packDir, ['rev-parse', '--show-prefix'], timeoutMs);
  if (where.kind === 'not-a-repository') return { kind: 'not-in-git' };
  if (where.kind === 'failed') return { kind: 'unknown' };
  // With no path after `--`, status would read the whole repository.
  if (asked.size === 0) return { kind: 'git', uncommitted: [] };
  const read = (command: readonly string[]) =>
    git(
      packDir,
      ['--no-optional-locks', '--literal-pathspecs', ...command, '--', ...asked],
      timeoutMs,
    );
  const status = await read(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored']);
  if (status.kind !== 'ok') return { kind: 'unknown' };
  const listed = listedFiles(status.stdout, where.stdout.replace(/\n$/, ''), asked);
  // `ls-files` names files from the folder it runs in, the pack's.
  const index = await read(['ls-files', '--cached', '-z']);
  if (index.kind !== 'ok') return { kind: 'unknown' };
  const known = new Set([...listed, ...index.stdout.split('\0')]);
  const elsewhere = await filesThere(
    packDir,
    [...asked].filter((file) => !known.has(file)),
  );
  if (elsewhere === undefined) return { kind: 'unknown' };
  return { kind: 'git', uncommitted: [...listed, ...elsewhere].sort() };
}

/**
 * `files` as git names them in the pack's folder: `/`-separated and
 * normalized. Undefined when one isn't a file in the folder: empty or the
 * folder itself, absolute, outside it, ending in `/`, or with a NUL, which
 * no path holds. As `pack-blocks.ts` reads a block's template file.
 */
function packPaths(files: readonly string[]): ReadonlySet<string> | undefined {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.includes('\0')) return undefined;
    const slashed = file.replaceAll('\\', '/');
    if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) return undefined;
    const normal = path.posix.normalize(slashed);
    if (normal === '.' || normal === '..' || normal.startsWith('../')) return undefined;
    if (normal.endsWith('/')) return undefined;
    paths.add(normal);
  }
  return paths;
}

/**
 * Those of `files` that are there in `packDir`, or undefined when one is a
 * folder or can't be looked at. One that isn't there holds nothing to lose.
 */
async function filesThere(
  packDir: string,
  files: readonly string[],
): Promise<readonly string[] | undefined> {
  const there: string[] = [];
  for (const file of files) {
    try {
      if ((await lstat(path.join(packDir, file))).isDirectory()) return undefined;
      there.push(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    }
  }
  return there;
}

/**
 * The files of `asked` that `git status --porcelain -z` output lists,
 * relative to the pack's folder, sorted. Each entry is `XY <path>`, the
 * path from the repository's root, which is `prefix` (`pack/`, or empty at
 * the root) and then the pack's own path. A rename or a copy (`R` or `C`
 * on either side) is followed by the path it came from, a field of its
 * own. A folder listed whole (`dir/`) lists each asked file in it: git
 * lists each file on its own when asked for files, but this doesn't
 * count on that.
 */
export function listedFiles(
  output: string,
  prefix: string,
  asked: ReadonlySet<string>,
): readonly string[] {
  const listed = new Set<string>();
  for (const path of statusPaths(output)) {
    if (!path.startsWith(prefix)) continue;
    for (const file of askedAt(path.slice(prefix.length), asked)) listed.add(file);
  }
  return [...listed].sort();
}

/** Each path the output lists: an entry's own, and a rename's or a copy's old one. */
function statusPaths(output: string): readonly string[] {
  const paths: string[] = [];
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] as string;
    // The empty field after the last NUL.
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(fields[++i] ?? '');
  }
  return paths;
}

/** The asked files a listed path is: itself, or each one in a folder listed whole. */
function askedAt(file: string, asked: ReadonlySet<string>): readonly string[] {
  if (!file.endsWith('/')) return asked.has(file) ? [file] : [];
  return [...asked].filter((a) => a.startsWith(file));
}
