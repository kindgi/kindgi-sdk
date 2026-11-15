// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { FILE_LIMITS } from '@kindgi/capabilities';

/**
 * The built-in tools an agent that declares `files` gets: `files.update`
 * offers `kindgi_update_file`, and `files.create` offers
 * `kindgi_create_file`. Built-in ids (`kindgi_<verb>`) have no dots: the
 * model calls exactly these names, the ones docs and instructions use.
 */
export const UPDATE_FILE_TOOL_ID = 'kindgi_update_file';
export const CREATE_FILE_TOOL_ID = 'kindgi_create_file';
export const FILE_TOOLS_VERSION = '1.0.0';

/**
 * The most text, in UTF-8 bytes, either tool writes in one call: a text
 * file's limit, `FILE_LIMITS.textBytes` (1 MB). A model isn't shown a
 * longer text file.
 */
export const MAX_MODEL_FILE_TEXT_BYTES = FILE_LIMITS.textBytes;

/**
 * The largest version, in bytes, `kindgi_update_file` changes. A model
 * reads a text file's first `FILE_LIMITS.textChars` characters, and UTF-8
 * never holds more characters than bytes, so a version of at most this many
 * bytes was read whole. A longer one may have been read cut, and its whole
 * new text would drop the rest.
 */
export const MAX_MODEL_UPDATED_FILE_BYTES = FILE_LIMITS.textChars;
