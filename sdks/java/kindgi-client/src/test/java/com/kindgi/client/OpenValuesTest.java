// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.kindgi.client.models.LiveScope;
import com.kindgi.client.models.Model;
import com.kindgi.client.models.Run;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URISyntaxException;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Every generated enum and union reads a value a newer runtime sends that this client doesn't know
 * yet, through the client's own codec: an enum as {@code UNRECOGNIZED}, keeping the text, and a
 * tagged or deduced union as its {@code Unrecognized} variant, keeping the object. The Python
 * client is held to the same by its generator's open check, apart from the field Python code
 * tells a method's answers apart by ({@code secrets.rotate}'s {@code kind}), which stays closed
 * there.
 */
class OpenValuesTest {
  private static final String UNKNOWN = "kindgi-test-unknown";

  /** Every class the models module generates, nested ones included. */
  private static List<Class<?>> models() throws IOException, URISyntaxException, ClassNotFoundException {
    Path location = Path.of(Model.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    String pkg = Model.class.getPackageName().replace('.', '/');
    List<Class<?>> found = new ArrayList<>();
    if (Files.isDirectory(location)) {
      collect(location.resolve(pkg), found);
    } else {
      try (FileSystem jar = FileSystems.newFileSystem(location)) {
        collect(jar.getPath(pkg), found);
      }
    }
    return found;
  }

  private static void collect(Path dir, List<Class<?>> found) throws IOException, ClassNotFoundException {
    List<String> names;
    try (Stream<Path> files = Files.list(dir)) {
      names = files.map(f -> f.getFileName().toString()).filter(n -> n.endsWith(".class")).sorted().toList();
    }
    for (String name : names) {
      found.add(Class.forName(Model.class.getPackageName() + "." + name.substring(0, name.length() - ".class".length())));
    }
  }

  /** {@code type}'s nested class {@code simpleName}, if it has one. */
  private static Class<?> nested(Class<?> type, String simpleName) {
    for (Class<?> inner : type.getDeclaredClasses()) {
      if (inner.getSimpleName().equals(simpleName)) {
        return inner;
      }
    }
    return null;
  }

  /** The name of an enum class's nested enum of known values: {@code Known} in a class named or nested in {@code Value}. */
  private static String knownValues(Class<?> type) {
    for (Class<?> c = type; c != null; c = c.getEnclosingClass()) {
      if (c.getSimpleName().equals("Value")) {
        return "Known";
      }
    }
    return "Value";
  }

  @Test
  void everyEnumReadsAValueItDoesntKnowAndKeepsIt() throws Exception {
    List<String> enums = new ArrayList<>();
    for (Class<?> type : models()) {
      Class<?> value = nested(type, knownValues(type));
      if (value == null || !value.isEnum()) {
        continue;
      }
      Object read = KindgiJson.read("\"" + UNKNOWN + "\"", type);
      assertThat(type.getMethod("value").invoke(read)).as(type.getName()).hasToString("UNRECOGNIZED");
      assertThat(type.getMethod("asString").invoke(read)).as(type.getName()).isEqualTo(UNKNOWN);
      assertThat(KindgiJson.write(read)).as(type.getName()).isEqualTo("\"" + UNKNOWN + "\"");
      enums.add(type.getName());
    }
    assertThat(enums).contains(Run.Status.class.getName()).hasSizeGreaterThan(100);
  }

  @Test
  void everyTaggedOrDeducedUnionReadsAVariantItDoesntKnowAndKeepsIt() throws Exception {
    List<String> unions = new ArrayList<>();
    for (Class<?> type : models()) {
      JsonTypeInfo info = type.getAnnotation(JsonTypeInfo.class);
      if (info == null || !type.isInterface()) {
        continue;
      }
      Class<?> unrecognized = nested(type, "Unrecognized");
      assertThat(info.defaultImpl()).as(type.getName()).isEqualTo(unrecognized);
      String body =
          info.use() == JsonTypeInfo.Id.NAME
              ? "{\"" + info.property() + "\":\"" + UNKNOWN + "\",\"kindgiTestExtra\":1}"
              : "{\"kindgiTestExtra\":1}";
      Object read = KindgiJson.read(body, type);
      assertThat(read).as(type.getName()).isInstanceOf(unrecognized);
      assertThat(KindgiJson.write(read)).as(type.getName()).isEqualTo(body);
      if (info.use() == JsonTypeInfo.Id.NAME) {
        Method tag = tagOf(type);
        assertThat(tag.invoke(read)).as(type.getName()).isEqualTo(UNKNOWN);
      }
      unions.add(type.getName());
    }
    assertThat(unions).contains(LiveScope.class.getName()).hasSizeGreaterThan(10);
  }

  /** A tagged union's own method for its tag: the one abstract method it declares that reads text. */
  private static Method tagOf(Class<?> union) {
    List<Method> tags = new ArrayList<>();
    for (Method m : union.getDeclaredMethods()) {
      if (java.lang.reflect.Modifier.isAbstract(m.getModifiers()) && m.getParameterCount() == 0 && m.getReturnType() == String.class) {
        tags.add(m);
      }
    }
    assertThat(tags).as(union.getName()).hasSize(1);
    return tags.get(0);
  }
}
