// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;

import com.palantir.javapoet.ClassName;
import com.palantir.javapoet.JavaFile;
import com.palantir.javapoet.MethodSpec;
import com.palantir.javapoet.ParameterizedTypeName;
import com.palantir.javapoet.TypeName;
import com.palantir.javapoet.TypeSpec;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Over the whole API: every value a newer runtime can add to (an enum value, a union's text value,
 * a union variant) is checked against the values this client knows before a body is sent, and every
 * body the client sends goes through those checks. The client's tests show the checks refuse only
 * on send.
 */
class OpenValuesPlanTest {
  private static final Path API = Path.of("../../../packages/api/openapi.json");

  private static ModelPlanner models;
  private static OperationPlanner operations;
  /** Every generated model type, nested ones included. */
  private static final Map<ClassName, TypeSpec> types = new HashMap<>();

  @BeforeAll
  static void plan() {
    Generator.Plan plan = Generator.plan(Generator.read(API));
    models = plan.models();
    operations = plan.operations();
    for (JavaFile f : new ModelWriter(models).files()) {
      collect(ClassName.get(f.packageName(), f.typeSpec().name()), f.typeSpec());
    }
  }

  private static void collect(ClassName name, TypeSpec type) {
    types.put(name, type);
    for (TypeSpec nested : type.typeSpecs()) {
      collect(name.nestedClass(nested.name()), nested);
    }
  }

  private static String validate(ClassName type) {
    for (MethodSpec m : types.get(type).methodSpecs()) {
      if (m.name().equals("validate")) {
        return m.code().toString();
      }
    }
    throw new AssertionError(type + " has no validate");
  }

  private static boolean reachesEnum(TypeName t) {
    if (t instanceof ParameterizedTypeName) {
      return ((ParameterizedTypeName) t).typeArguments().stream().anyMatch(OpenValuesPlanTest::reachesEnum);
    }
    return t instanceof ClassName && models.index.get(t) instanceof Ir.EnumDecl;
  }

  @Test
  void everyFieldThatReachesAnEnumIsChecked() {
    List<String> fields = new ArrayList<>();
    for (Ir.Decl d : models.index.values()) {
      if (!(d instanceof Ir.RecordDecl)) {
        continue;
      }
      for (Ir.Field f : ((Ir.RecordDecl) d).fields) {
        if (reachesEnum(f.type)) {
          String value = f.triState ? f.java + ".orElse(null)" : f.java;
          assertThat(validate(d.name())).as(d.name() + "." + f.wire).contains("checks.nested(\"" + f.wire + "\", " + value + ");");
          fields.add(String.join(".", d.name().simpleNames()) + "." + f.wire);
        }
      }
    }
    assertThat(fields).contains("Run.status", "MintSystemKeyBody.scopes", "CreateWebhookEndpointBody.events").hasSizeGreaterThan(100);
  }

  @Test
  void everyEnumIsOpen() {
    int enums = 0;
    for (Ir.Decl d : models.index.values()) {
      if (d instanceof Ir.EnumDecl) {
        assertThat(types.get(d.name()).superinterfaces()).as(d.name().toString()).contains(ModelWriter.OPEN_ENUM);
        enums++;
      }
    }
    assertThat(enums).isGreaterThan(100);
  }

  @Test
  void everyVariantThisClientDoesntKnowIsRefusedOnSend() {
    int unions = 0;
    for (Ir.Decl d : models.index.values()) {
      if (!(d instanceof Ir.UnionDecl) || ((Ir.UnionDecl) d).unrecognized == null) {
        continue;
      }
      Ir.UnionDecl u = (Ir.UnionDecl) d;
      String code = validate(u.unrecognized);
      if (u.tagWire != null && u.objectKind == Ir.UnionKind.TAGGED) {
        assertThat(code).as(u.name.toString()).startsWith("checks.unrecognized(\"" + u.tagWire + "\", java.util.List.of(");
        for (Ir.Variant v : u.variants) {
          for (String tag : v.tags() == null ? List.<String>of() : v.tags()) {
            assertThat(code).as(u.name + " " + tag).contains("\"" + tag + "\"");
          }
        }
      } else {
        assertThat(code).as(u.name.toString()).isEqualTo("checks.unrecognized();\n");
      }
      unions++;
    }
    assertThat(unions).isGreaterThan(10);
  }

  @Test
  void aUnionsTextValueIsCheckedOnlyOnSend() {
    List<String> unions = new ArrayList<>();
    for (Ir.Decl d : models.index.values()) {
      if (!(d instanceof Ir.UnionDecl) || ((Ir.UnionDecl) d).textVariant() == null) {
        continue;
      }
      Ir.Variant text = ((Ir.UnionDecl) d).textVariant();
      String code = validate(text.type());
      assertThat(code).as(d.name().toString()).doesNotContain("checks.oneOf(");
      if (text.allowed() != null) {
        assertThat(code).as(d.name().toString()).startsWith("checks.known(\"\", value, ");
        unions.add(String.join(".", d.name().simpleNames()));
      }
    }
    assertThat(unions).containsExactly("TestRunBaseline");
  }

  @Test
  void everyJsonBodyIsAModelOrAMapOfAnything() {
    // The client checks a body only when it's a model (Transport): a list or map of models
    // would need its items checked too.
    TypeName anything = ParameterizedTypeName.get(ModelPlanner.MAP, ModelPlanner.STRING, ModelPlanner.OBJECT);
    List<String> maps = new ArrayList<>();
    for (OperationPlanner.Op op : operations.ops) {
      if (!"json".equals(op.bodyKind)) {
        continue;
      }
      Ir.Decl d = op.body instanceof ClassName ? models.index.get(op.body) : null;
      if (d instanceof Ir.RecordDecl || d instanceof Ir.UnionDecl) {
        continue;
      }
      assertThat(op.body.withoutAnnotations()).as(op.id).isEqualTo(anything);
      maps.add(op.id);
    }
    assertThat(maps).containsExactlyInAnyOrder("adapters.test", "adapters.prepare");
  }

  /**
   * The unions an answer can carry whose variants have no tag. Java reads a variant it doesn't
   * know there as {@code Unrecognized}; the Python client has a fallback only for a union told
   * apart by a tag, so it can't read one in these.
   */
  @Test
  void theUntaggedUnionsAnAnswerCanCarry() {
    Deque<TypeName> todo = new ArrayDeque<>();
    for (OperationPlanner.Op op : operations.ops) {
      if (op.response != null) {
        todo.add(op.response);
      }
      if (op.byStatus != null) {
        todo.addAll(op.byStatus.values());
      }
    }
    Set<TypeName> seen = new HashSet<>();
    Set<String> untagged = new TreeSet<>();
    while (!todo.isEmpty()) {
      TypeName t = todo.pop().withoutAnnotations();
      if (!seen.add(t)) {
        continue;
      }
      if (t instanceof ParameterizedTypeName) {
        todo.addAll(((ParameterizedTypeName) t).typeArguments());
        continue;
      }
      Ir.Decl d = t instanceof ClassName ? models.index.get(t) : null;
      if (d instanceof Ir.RecordDecl) {
        for (Ir.Field f : ((Ir.RecordDecl) d).fields) {
          todo.add(f.type);
        }
      } else if (d instanceof Ir.UnionDecl) {
        Ir.UnionDecl u = (Ir.UnionDecl) d;
        if (u.unrecognized != null && !(u.tagWire != null && u.objectKind == Ir.UnionKind.TAGGED)) {
          untagged.add(String.join(".", u.name.simpleNames()));
        }
        for (Ir.Variant v : u.variants) {
          todo.add(v.type());
        }
      }
    }
    assertThat(untagged).containsExactly("BlockContent", "TestRunBaseline", "IdentityProviderSignIn", "MemoryErasureSelector");
  }
}
