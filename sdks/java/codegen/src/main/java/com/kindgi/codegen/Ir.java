// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import com.palantir.javapoet.ClassName;
import com.palantir.javapoet.TypeName;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** What the generator plans before it writes Java: the types, their members and their checks. */
final class Ir {
  private Ir() {}

  /** The constraints a value carries from its schema, checked when a request is built. */
  record Constraints(
      Integer minLength,
      Integer maxLength,
      String pattern,
      BigDecimal minimum,
      BigDecimal maximum,
      BigDecimal exclusiveMinimum,
      Integer minItems,
      Integer maxItems,
      boolean uniqueItems,
      Integer minProperties,
      Integer maxProperties,
      Constraints items,
      Constraints keys,
      Constraints values) {
    static final Constraints NONE =
        new Constraints(null, null, null, null, null, null, null, null, false, null, null, null, null, null);

    boolean isEmpty() {
      return minLength == null
          && maxLength == null
          && pattern == null
          && minimum == null
          && maximum == null
          && exclusiveMinimum == null
          && minItems == null
          && maxItems == null
          && !uniqueItems
          && minProperties == null
          && maxProperties == null
          && (items == null || items.isEmpty())
          && (keys == null || keys.isEmpty())
          && (values == null || values.isEmpty());
    }
  }

  /** A record component: one property of an object schema. */
  static final class Field {
    String wire;
    String java;
    TypeName type;
    boolean required;
    /** `null` is an allowed value. */
    boolean nullable;
    /** Optional and nullable: absent, an explicit `null`, or a value (`OptionalNullable`). */
    boolean triState;
    /** A `const` property: always this value (as JSON text). */
    Object constValue;
    /** This property tells a union's variants apart: its allowed values. */
    List<String> tagValues;
    String description;
    Constraints constraints = Constraints.NONE;
    Object defaultValue;
    /** The field's type is a union with a text variant: the builder also takes a string. */
    UnionDecl textUnion;
  }

  sealed interface Decl permits RecordDecl, EnumDecl, UnionDecl {
    ClassName name();
  }

  static final class RecordDecl implements Decl {
    final ClassName name;
    final String description;
    final List<Field> fields = new ArrayList<>();
    final List<Decl> nested = new ArrayList<>();
    final Set<ClassName> interfaces = new LinkedHashSet<>();
    /** Unknown properties are kept (`additionalProperties` alongside `properties`). */
    boolean open;
    TypeName openValueType;

    RecordDecl(ClassName name, String description) {
      this.name = name;
      this.description = description;
    }

    @Override
    public ClassName name() {
      return name;
    }
  }

  /** A string enum, tolerant of values this client doesn't know. */
  record EnumDecl(ClassName name, String description, List<String> values) implements Decl {}

  enum UnionKind {
    /** Objects told apart by a property with a fixed value per variant (`kind`, `type`, …). */
    TAGGED,
    /** Objects told apart by which properties they have. */
    DEDUCED,
    /** A string, or one of some objects. */
    TEXT_OR_OBJECT,
    /** A response whose shape depends on its HTTP status. */
    BY_STATUS
  }

  static final class UnionDecl implements Decl {
    final ClassName name;
    final String description;
    final UnionKind kind;
    /** TAGGED (also the objects of a TEXT_OR_OBJECT when they're tagged): the tag property. */
    String tagWire;
    String tagJava;
    /** How the objects of a TEXT_OR_OBJECT are told apart: TAGGED, DEDUCED, or null (one object). */
    UnionKind objectKind;
    final List<Variant> variants = new ArrayList<>();
    final List<Decl> nested = new ArrayList<>();
    /** The catch-all variant for a tag or a shape this client doesn't know. */
    ClassName unrecognized;

    UnionDecl(ClassName name, String description, UnionKind kind) {
      this.name = name;
      this.description = description;
      this.kind = kind;
    }

    @Override
    public ClassName name() {
      return name;
    }

    Variant textVariant() {
      for (Variant v : variants) {
        if (v.text) {
          return v;
        }
      }
      return null;
    }
  }

  /**
   * One variant of a union: an object type, or (`text`) a string wrapped in a small record. A
   * text variant may allow only some values (`allowed`).
   */
  record Variant(ClassName type, List<String> tags, List<String> uniqueRequired, boolean text, List<String> allowed) {}
}
