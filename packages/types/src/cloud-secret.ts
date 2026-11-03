// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A cloud secret: one numbered version of a secret in Google Cloud Secret
 * Manager, by its resource name, `projects/<project>/secrets/<secret>/versions/<number>`.
 * An env name set to one is given to a pack service by that name, and the
 * cloud reads the value: the runtime never holds or reads it. A version is
 * a number, never `latest` or an alias, so what a pack service runs only
 * changes when the reference does. A secret whose id starts with `kp-` is
 * never one: those are the pack services' own copies.
 */
export interface CloudSecretVersion {
  /** The project's id (6 to 30 lowercase letters, digits and hyphens) or number. */
  readonly project: string;
  /** The secret's id: 1 to 255 letters, digits, `_` and `-`. */
  readonly secret: string;
  /** The version's number, as written: a positive integer with no leading zero. */
  readonly version: string;
}

const CLOUD_SECRET_VERSION =
  /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]{0,29})\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\/([1-9][0-9]{0,18})$/;

/** The form a cloud secret is written in, for messages. */
export const CLOUD_SECRET_FORM = 'projects/<project>/secrets/<secret>/versions/<number>';

/**
 * `raw` as a cloud secret version, or why it isn't one. The message names
 * the form and never quotes `raw`.
 */
export function parseCloudSecretVersion(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly value: CloudSecretVersion }
  | { readonly kind: 'err'; readonly message: string } {
  if (typeof raw !== 'string') {
    return { kind: 'err', message: `A cloud secret is a string: ${CLOUD_SECRET_FORM}.` };
  }
  const m = CLOUD_SECRET_VERSION.exec(raw);
  if (m === null) {
    return {
      kind: 'err',
      message: /\/versions\/(latest|[^/0-9][^/]*)$/.test(raw)
        ? `A cloud secret names a numbered version, never \`latest\` or an alias: ${CLOUD_SECRET_FORM}.`
        : `A cloud secret is written ${CLOUD_SECRET_FORM}, with a project id or number, a secret id of letters, digits, \`_\` and \`-\`, and a version number.`,
    };
  }
  const [, project, secret, version] = m as unknown as [string, string, string, string];
  // A pack service's orchestrator keeps its own copies of a deployment's
  // values as `kp-` secrets, which every pack service's account can read:
  // one named here would give a pack service another deployment's value.
  if (secret.startsWith('kp-')) {
    return {
      kind: 'err',
      message:
        "A cloud secret can't be one whose id starts with `kp-`: those are the pack services' own copies.",
    };
  }
  return { kind: 'ok', value: { project, secret, version } };
}
