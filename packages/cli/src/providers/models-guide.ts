// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { docsUrl } from '@kindgi/client/sso-handoff';

import { CLI_VERSION } from '../version-info.js';

/**
 * The guide to connecting a model, on this CLI's release line: where
 * `kindgi dev`'s banner and `kindgi init`'s next steps send a person whose
 * agents have no model yet. The command itself stays in `kindgi doctor`.
 */
export const MODELS_GUIDE = docsUrl('guides/models/', CLI_VERSION);
