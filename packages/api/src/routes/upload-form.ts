// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An upload's multipart form and the project it belongs to: shared by
 * `POST /v1/artifacts` and the files routes.
 */

import type { BlobPutInput } from '@kindgi/blob-binding';
import type { ProjectBinding } from '@kindgi/platform';
import type { RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId } from '@kindgi/types';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';

export type ValidationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

/**
 * Parse the multipart form into a `BlobPutInput`. `file` is required —
 * every other field is optional metadata. `tags` is a JSON-encoded
 * object; `ownerRunId` is a plain string; `expectedHash` is
 * `sha256`-hex; `contentType` overrides the file part's own MIME.
 * `name` defaults to the file part's filename.
 */
export function validateUploadForm(form: FormData): ValidationResult<BlobPutInput> {
  const file = form.get('file');
  if (file === null) {
    return { kind: 'err', message: 'Multipart form must include a `file` part' };
  }
  if (typeof file === 'string') {
    return { kind: 'err', message: '`file` part must be a file, not a string field' };
  }

  const nameField = form.get('name');
  const name =
    typeof nameField === 'string' && nameField.length > 0
      ? nameField
      : file.name !== undefined && file.name.length > 0
        ? file.name
        : 'unnamed';

  const contentTypeField = form.get('contentType');
  const contentType =
    typeof contentTypeField === 'string' && contentTypeField.length > 0
      ? contentTypeField
      : file.type.length > 0
        ? file.type
        : 'application/octet-stream';

  let tags: Record<string, string> | undefined;
  const tagsField = form.get('tags');
  if (typeof tagsField === 'string' && tagsField.length > 0) {
    try {
      const parsed = JSON.parse(tagsField) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'err', message: 'Field `tags` must be a JSON object' };
      }
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return { kind: 'err', message: `Field \`tags["${k}"]\` must be a string` };
        }
        flat[k] = v;
      }
      tags = flat;
    } catch {
      return { kind: 'err', message: 'Field `tags` must be valid JSON' };
    }
  }

  let ownerRunId: RunId | undefined;
  const ownerField = form.get('ownerRunId');
  if (typeof ownerField === 'string' && ownerField.length > 0) {
    ownerRunId = ownerField as RunId;
  }

  let projectId: ProjectId | undefined;
  const projectField = form.get('projectId');
  if (typeof projectField === 'string' && projectField.length > 0) {
    projectId = projectField as ProjectId;
  }

  let expectedHash: string | undefined;
  const hashField = form.get('expectedHash');
  if (typeof hashField === 'string' && hashField.length > 0) {
    if (!/^[0-9a-f]{64}$/.test(hashField)) {
      return {
        kind: 'err',
        message: 'Field `expectedHash` must be sha256, hex-encoded, lowercase (64 chars)',
      };
    }
    expectedHash = hashField;
  }

  return {
    kind: 'ok',
    value: {
      name,
      contentType,
      bytes: file.stream(),
      size: file.size,
      ...(tags !== undefined && { tags }),
      ...(ownerRunId !== undefined && { ownerRunId }),
      ...(projectId !== undefined && { projectId }),
      ...(expectedHash !== undefined && { expectedHash }),
    },
  };
}

export type UploadProject =
  | { readonly kind: 'ok'; readonly projectId?: ProjectId }
  | { readonly kind: 'err'; readonly code: string; readonly message: string };

/**
 * The project an upload belongs to: its owner run's (the upload's
 * `projectId`, if any, must agree), else the upload's `projectId`, else
 * the project the caller's API key is limited to, else the tenant's
 * default project.
 */
export async function uploadProject(
  c: Context<AppEnv>,
  deps: { readonly runBinding?: RunBinding; readonly projectBinding?: ProjectBinding },
  input: BlobPutInput,
): Promise<UploadProject> {
  const tenantId = c.get('tenantId') as TenantId;
  const named = input.projectId;
  if (input.ownerRunId !== undefined && deps.runBinding !== undefined) {
    const run = await deps.runBinding.getRun(tenantId, input.ownerRunId);
    if (run === null) {
      return {
        kind: 'err',
        code: 'run-not-found',
        message: `No run "${input.ownerRunId as unknown as string}"`,
      };
    }
    const runProject = run.projectId as unknown as ProjectId;
    if (named !== undefined && named !== runProject) {
      return {
        kind: 'err',
        code: 'bad-input',
        message: `\`projectId\` must be the owner run's project ("${runProject as unknown as string}"), or absent`,
      };
    }
    return { kind: 'ok', projectId: runProject };
  }
  if (named !== undefined) return { kind: 'ok', projectId: named };
  const keyProject = c.get('tokenProjectId');
  if (keyProject !== undefined) return { kind: 'ok', projectId: keyProject as ProjectId };
  const fallback = (await deps.projectBinding?.getDefault(tenantId))?.id;
  return { kind: 'ok', ...(fallback !== undefined && { projectId: fallback }) };
}
