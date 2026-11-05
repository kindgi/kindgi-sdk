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
