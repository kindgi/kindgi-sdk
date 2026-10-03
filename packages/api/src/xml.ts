// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Minimal hand-rolled XML serialization for the S3-compat wire
 * surface. S3 response shapes are shallow (5 or so total across the
 * surface); pulling in a full XML library would be overkill.
 *
 * Every serializer emits a single top-level element with the XML prolog
 * and the S3-standard namespace (`http://s3.amazonaws.com/doc/2006-03-01/`).
 * Escaping is applied to text content and attribute values.
 */

const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';
const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/';

/**
 * S3-standard error body. `<Error><Code>...</Code><Message>...</Message>...</Error>`.
 */
export function errorXml(
  code: string,
  message: string,
  extra: Readonly<Record<string, string>> = {},
): string {
  const extraTags = Object.entries(extra)
    .map(([k, v]) => tag(k, v))
    .join('');
  return `${XML_PROLOG}<Error>${tag('Code', code)}${tag('Message', message)}${extraTags}</Error>`;
}

/**
 * S3 `ListObjectsV2` result envelope. `contents` are the matched keys
 * with metadata; `CommonPrefixes` is never emitted — delimiters are not
 * supported.
 */
export interface ListBucketResultInput {
  readonly bucket: string;
  readonly prefix: string;
  readonly maxKeys: number;
  readonly isTruncated: boolean;
  readonly continuationToken?: string;
  readonly nextContinuationToken?: string;
  readonly contents: ReadonlyArray<{
    readonly key: string;
    readonly lastModified: string;
    readonly etag: string;
    readonly size: number;
  }>;
}

export function listBucketResultXml(input: ListBucketResultInput): string {
  const contents = input.contents
    .map(
      (c) =>
        `<Contents>${tag('Key', c.key)}${tag('LastModified', c.lastModified)}${tag('ETag', quote(c.etag))}${tag('Size', String(c.size))}${tag('StorageClass', 'STANDARD')}</Contents>`,
    )
    .join('');
  const parts = [
    tag('Name', input.bucket),
    tag('Prefix', input.prefix),
    tag('KeyCount', String(input.contents.length)),
    tag('MaxKeys', String(input.maxKeys)),
    tag('IsTruncated', input.isTruncated ? 'true' : 'false'),
    ...(input.continuationToken !== undefined
      ? [tag('ContinuationToken', input.continuationToken)]
      : []),
    ...(input.nextContinuationToken !== undefined
      ? [tag('NextContinuationToken', input.nextContinuationToken)]
      : []),
    contents,
  ];
  return `${XML_PROLOG}<ListBucketResult xmlns="${S3_NS}">${parts.join('')}</ListBucketResult>`;
}

/**
 * S3 `InitiateMultipartUpload` result envelope.
 */
export interface InitiateMultipartUploadResultInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
}

export function initiateMultipartUploadResultXml(
  input: InitiateMultipartUploadResultInput,
): string {
  const parts = [
    tag('Bucket', input.bucket),
    tag('Key', input.key),
    tag('UploadId', input.uploadId),
  ];
  return `${XML_PROLOG}<InitiateMultipartUploadResult xmlns="${S3_NS}">${parts.join('')}</InitiateMultipartUploadResult>`;
}

/**
 * S3 `CompleteMultipartUpload` result envelope.
 */
export interface CompleteMultipartUploadResultInput {
  readonly bucket: string;
  readonly key: string;
  readonly etag: string;
  readonly location: string;
}

export function completeMultipartUploadResultXml(
  input: CompleteMultipartUploadResultInput,
): string {
  const parts = [
    tag('Location', input.location),
    tag('Bucket', input.bucket),
    tag('Key', input.key),
    tag('ETag', quote(input.etag)),
  ];
  return `${XML_PROLOG}<CompleteMultipartUploadResult xmlns="${S3_NS}">${parts.join('')}</CompleteMultipartUploadResult>`;
}

/**
 * S3 `ListParts` result envelope.
 */
export interface ListPartsResultInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly parts: ReadonlyArray<{
    readonly partNumber: number;
    readonly etag: string;
    readonly size: number;
    readonly lastModified: string;
  }>;
}

export function listPartsResultXml(input: ListPartsResultInput): string {
  const parts = input.parts
    .map(
      (p) =>
        `<Part>${tag('PartNumber', String(p.partNumber))}${tag('LastModified', p.lastModified)}${tag('ETag', quote(p.etag))}${tag('Size', String(p.size))}</Part>`,
    )
    .join('');
  return `${XML_PROLOG}<ListPartsResult xmlns="${S3_NS}">${tag('Bucket', input.bucket)}${tag('Key', input.key)}${tag('UploadId', input.uploadId)}${parts}</ListPartsResult>`;
}

// -------------------- parsing (CompleteMultipartUpload body) --------------------

/**
 * Parse the `CompleteMultipartUpload` request body:
 *
 *   <CompleteMultipartUpload>
 *     <Part>
 *       <PartNumber>1</PartNumber>
 *       <ETag>"..."</ETag>
 *     </Part>
 *     ...
 *   </CompleteMultipartUpload>
 *
 * Returns the declared parts in body order (S3 REQUIRES ascending
 * PartNumber; the completer verifies before assembling). Hand-rolled
 * regex — the shape is trivial and the input is machine-generated by
 * AWS SDKs.
 */
export function parseCompleteMultipartUploadXml(
  body: string,
): { partNumber: number; etag: string }[] | null {
  const parts: { partNumber: number; etag: string }[] = [];
  const partRe =
    /<Part>\s*(?:<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>|<ETag>([^<]+)<\/ETag>\s*<PartNumber>(\d+)<\/PartNumber>)\s*<\/Part>/g;
  let match: RegExpExecArray | null = partRe.exec(body);
  while (match !== null) {
    const partNumber = Number.parseInt((match[1] ?? match[4]) as string, 10);
    const etagRaw = (match[2] ?? match[3]) as string;
    const etag = etagRaw.replace(/^"|"$/g, '');
    if (!Number.isFinite(partNumber) || partNumber < 1) return null;
    parts.push({ partNumber, etag });
    match = partRe.exec(body);
  }
  if (parts.length === 0) return null;
  return parts;
}

// -------------------- primitives --------------------

function tag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function quote(s: string): string {
  return s.startsWith('"') ? s : `"${s}"`;
}

// In XML text content, only `&` and `<` MUST be escaped (`>` is only
// required inside `]]>`). `"` and `'` need escaping only in attribute
// values. S3 responses don't use attribute values, so we escape the
// minimum set — matching what real S3 emits (e.g. `<ETag>"abc"</ETag>`
// with literal quotes).
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
