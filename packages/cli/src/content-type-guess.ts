// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { extname } from 'node:path';

/**
 * The type `kindgi files upload` gives a file without `--content-type`, by
 * its extension: a short fixed table, so the same file gets the same type
 * on every machine. Code gets a `text/*` type, so the server compares its
 * versions line by line.
 */
const BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.xml', 'application/xml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.jsx', 'text/javascript'],
  ['.ts', 'text/x-typescript'],
  ['.tsx', 'text/x-typescript'],
  ['.py', 'text/x-python'],
  ['.java', 'text/x-java'],
  ['.kt', 'text/x-kotlin'],
  ['.scala', 'text/x-scala'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.rb', 'text/x-ruby'],
  ['.php', 'text/x-php'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.cs', 'text/x-csharp'],
  ['.sh', 'text/x-shellscript'],
  ['.sql', 'text/x-sql'],
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** `path`'s type by its extension (any case), else `application/octet-stream`. */
export function guessContentType(path: string): string {
  return BY_EXTENSION.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}
