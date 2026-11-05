// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in tools an agent that declares `files` gets: `files.update`
 * offers `kindgi_update_file`, and `files.create` offers
 * `kindgi_create_file`. Built-in ids (`kindgi_<verb>`) have no dots: the
 * model calls exactly these names, the ones docs and instructions use.
 */
export const UPDATE_FILE_TOOL_ID = 'kindgi_update_file';
export const CREATE_FILE_TOOL_ID = 'kindgi_create_file';
export const FILE_TOOLS_VERSION = '1.0.0';

/** The most text, in UTF-8 bytes (1 MiB), either tool writes in one call. */
export const MAX_MODEL_FILE_TEXT_BYTES = 1_048_576;
