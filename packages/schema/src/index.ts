// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export { canonicalize } from './canonical.js';
export type {
  InvalidZodConversionError,
  SchemaCompileError,
  SchemaError,
  SchemaLoadError,
  SchemaNotFoundError,
  SchemaParseError,
  ValidationError,
} from './errors.js';
export { compileInlineSchema, createSpecRegistry, loadSpecRegistry } from './registry.js';
export { ALLOW_UNION_TYPES, compileJsonSchema, jsonSchemaDialect } from './dialect.js';
export type { CompileJsonSchemaOptions, JsonSchemaDialect } from './dialect.js';
export type { CompiledInlineSchema, SpecRegistry, ValidationErrorLike } from './registry.js';
export { versionOf } from './version.js';
export type { SchemaVersion } from './version.js';
export {
  isJsonSchemaObject,
  isZodSchema,
  loadZodConverter,
  loadZodConverterSync,
  parseWithSchema,
  schemaKindOf,
  toJSONSchema,
  toJSONSchemaSync,
} from './zod.js';
export type {
  AnySchema,
  JSONSchemaObject,
  SchemaIo,
  SchemaIssue,
  SchemaKind,
  ZodConverter,
  ZodLikeSchema,
} from './zod.js';
